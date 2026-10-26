/**
 * 共享技能（组织共享面，kind='skill' + channel='org'）。
 *
 * 数据模型：apps / app_releases / app_grants 三张统一应用表（旧 shared_skills、
 * shared_skill_grants 已下线）。语义与 Go 端 internal/serverstore/shared_skills.go +
 * internal/sharedskills/routes.go 对齐：
 *  - 员工面只发「已审核通过 + 已分发（未下架）」的版本；
 *  - 作者面（我的）看自己 App 的全部版本，忽略审核状态与下架；
 *  - 管理面看到 org 通道的全部版本（含 pending/rejected）；
 *  - 拒绝即释放归档（app_releases.archive 置空），因此被拒版本不能再通过审核；
 *  - 删除整 App 不允许硬删 apps 行（app_releases 有 ON DELETE CASCADE），
 *    改为逐版本软删 + 授权清理。
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { groups, users, type App, type AppRelease } from '../db/schema';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/errors/api-error';
import { formatDateTime, isAppId, isVersion, normalizeGrantee } from '../common/skills-shared';
import { resolveUserEffectiveGroups } from '../common/effective-groups';
import {
  CHANNEL_MARKET,
  CHANNEL_ORG,
  STATUS_APPROVED,
  STATUS_PENDING,
  STATUS_REJECTED,
  accessibleAppIds,
  appDistribution,
  compareVersions,
  createRelease,
  deleteAppGrants,
  delivered,
  distributionOf,
  distributionStates,
  getApp,
  getRelease,
  grantApp,
  incrementReleaseDownload,
  listAppGrants,
  listApps,
  listReleases,
  listReleasesByStatus,
  ownedBy,
  replaceGroupGrants,
  revokeApp,
  setAppEnabled,
  setReleaseQuality,
  setReleaseStatusForReview,
  softDeleteRelease,
  upsertApp,
  writable,
} from '../common/apps-shared';
import { isGzip, isZip, listArchiveEntries, readArchiveEntry, readArchiveText } from './zip-archive';

const KIND = 'skill' as const;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_REASON_LEN = 500;
/** 预览 / 单文件读取上限（与 Go maxFilePreviewBytes / MaxSkillMDBytes 对齐）。 */
const MAX_PREVIEW_BYTES = 128 * 1024;
const QUALITY_FLAGS = new Set(['', 'featured']);
const REASON_MISSING = '请填写拒绝理由';
const REASON_TOO_LONG = '拒绝理由过长(上限 500 字)';

/** 共享技能 JSON（snake_case，与 Go sharedSkillJSON 逐字段对齐）。 */
export interface SharedSkillJSON {
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: string;
  status: string;
  reason: string;
  quality: string;
  downloads: number;
  calls: number;
  created_at: string;
  updated_at: string;
}

export interface SharedSkillGrantJSON {
  grantee_type: 'user' | 'group';
  grantee: string;
}

/** 二进制归档响应描述（controller 负责写 header 与 body）。 */
export interface ArchivePayload {
  payload: Buffer;
  filename: string;
  contentType: string;
  version: string;
  checksum: string;
}

export interface SharedSkillPreviewJSON {
  files: Array<{ path: string; size: number }>;
  skill_md: string;
}

export interface SharedSkillFileJSON {
  path: string;
  size: number;
  binary: boolean;
  too_large: boolean;
  content: string;
}

export interface SharedSkillUploadBody {
  name?: unknown;
  display_name?: unknown;
  version?: unknown;
  description?: unknown;
  author?: unknown;
  archive?: unknown;
}

export interface SharedSkillGrantBody {
  username?: unknown;
  group?: unknown;
}

export interface SharedSkillEnabledBody {
  enabled?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function checksumOf(payload: Buffer): string {
  return createHash('sha256').update(payload).digest('hex');
}

function archiveFilename(name: string, version: string, payload: Buffer): string {
  const suffix = isZip(payload) ? 'zip' : isGzip(payload) ? 'tar.gz' : 'bin';
  return `${name}-${version}.${suffix}`;
}

@Injectable()
export class SharedSkillsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** 管理端全量权限（与 Go AdminFull 一致：super_admin / auditor）。 */
  private adminFull(role: string): boolean {
    return role === 'super_admin' || role === 'auditor';
  }

  private toJSON(release: AppRelease, app: App | null): SharedSkillJSON {
    const displayName = text(app?.title) || release.appId;
    const description = text(app?.description) || (release.description ?? '');
    return {
      name: release.appId,
      display_name: displayName,
      version: release.version,
      description,
      // Go 投影：Author 取 publisher（上传账号），老数据可能只有 author。
      author: release.publisher || release.author || '',
      status: release.status,
      reason: release.reason ?? '',
      quality: release.quality ?? '',
      downloads: Number(release.downloads ?? 0),
      calls: Number(release.calls ?? 0),
      created_at: formatDateTime(release.createdAt),
      updated_at: formatDateTime(release.updatedAt),
    };
  }

  private sortRows(
    rows: Array<{ release: AppRelease; app: App | null }>,
  ): Array<{ release: AppRelease; app: App | null }> {
    return rows.sort((left, right) => {
      if (left.release.appId !== right.release.appId) {
        return left.release.appId < right.release.appId ? -1 : 1;
      }
      return compareVersions(right.release.version, left.release.version);
    });
  }

  /** 组织共享技能的 App 行（market 通道的技能走商城接口，这里一律 404）。 */
  private async requireOrgSkill(name: string): Promise<App> {
    const app = await getApp(this.db, KIND, name);
    if (!app || app.channel !== CHANNEL_ORG) throw new ApiError('NOT_FOUND', '技能不存在');
    return app;
  }

  private async orgApps(): Promise<Map<string, App>> {
    const rows = await listApps(this.db, KIND, CHANNEL_ORG);
    return new Map(rows.map((app) => [app.appId, app]));
  }

  private async accessibleNamesFor(
    username: string,
    role: string,
    userId: number,
  ): Promise<Set<string> | null> {
    if (this.adminFull(role)) return null;
    const groupsOfUser = await resolveUserEffectiveGroups(this.db, userId);
    const names = await accessibleAppIds(this.db, KIND, username, groupsOfUser);
    return new Set(names.map((name) => name.toLowerCase()));
  }

  /** 员工面可见技能：已通过审核 + 已分发 +（管理员 / 本人 / 被授权）。 */
  async listVisibleForEmployee(
    username: string,
    role: string,
    userId: number,
  ): Promise<Array<SharedSkillJSON & { enabled: boolean }>> {
    const appsById = await this.orgApps();
    if (appsById.size === 0) return [];
    const states = await distributionStates(this.db, KIND);
    const granted = await this.accessibleNamesFor(username, role, userId);
    const rows = await listReleasesByStatus(this.db, KIND);
    const visible: Array<{ release: AppRelease; app: App | null }> = [];
    for (const release of rows) {
      const app = appsById.get(release.appId);
      if (!app) continue;
      if (release.status !== STATUS_APPROVED) continue;
      const dist = distributionOf(states, release.appId);
      if (!delivered(dist)) continue;
      if (granted && !ownedBy(dist, username) && !granted.has(release.appId.toLowerCase())) {
        continue;
      }
      visible.push({ release, app });
    }
    return this.sortRows(visible).map(({ release, app }) => ({
      ...this.toJSON(release, app),
      enabled: Boolean(app?.enabled),
    }));
  }

  /** 作者面（我的）：自己 App 的全部版本，忽略审核状态与下架。 */
  async listOwned(username: string): Promise<SharedSkillJSON[]> {
    const appsById = await this.orgApps();
    if (appsById.size === 0) return [];
    const states = await distributionStates(this.db, KIND);
    const rows = await listReleasesByStatus(this.db, KIND);
    const owned: Array<{ release: AppRelease; app: App | null }> = [];
    for (const release of rows) {
      const app = appsById.get(release.appId);
      if (!app) continue;
      if (!ownedBy(distributionOf(states, release.appId), username)) continue;
      owned.push({ release, app });
    }
    return this.sortRows(owned).map(({ release, app }) => this.toJSON(release, app));
  }

  private normalizeStatus(status: unknown): string | null {
    const value = text(status);
    if (!value) return null;
    if (value === STATUS_PENDING || value === STATUS_APPROVED || value === STATUS_REJECTED) {
      return value;
    }
    return '__invalid__';
  }

  /** 管理面：org 通道全部版本（含审核中 / 已拒绝，不含已软删）。 */
  async listAll(status?: string): Promise<SharedSkillJSON[]> {
    const wanted = this.normalizeStatus(status);
    if (wanted === '__invalid__') return [];
    const appsById = await this.orgApps();
    if (appsById.size === 0) return [];
    const rows = await listReleasesByStatus(this.db, KIND, wanted ?? undefined);
    const kept: Array<{ release: AppRelease; app: App | null }> = [];
    for (const release of rows) {
      const app = appsById.get(release.appId);
      if (!app) continue;
      kept.push({ release, app });
    }
    return this.sortRows(kept).map(({ release, app }) => this.toJSON(release, app));
  }

  private decodeArchive(raw: unknown): Buffer {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new ApiError('VALIDATION', '归档内容必填(base64)');
    }
    const cleaned = raw.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
      throw new ApiError('VALIDATION', '归档内容必须是合法 base64');
    }
    const payload = Buffer.from(cleaned, 'base64');
    if (payload.length === 0) throw new ApiError('VALIDATION', '归档内容为空');
    if (payload.length > MAX_ARCHIVE_BYTES) {
      throw new ApiError('PAYLOAD_TOO_LARGE', `归档大小超过上限(${MAX_ARCHIVE_BYTES} 字节)`);
    }
    return payload;
  }

  /** 上传：upsertApp + createRelease(status=pending)。同 (kind,appId,version) 冲突。 */
  async upload(
    body: SharedSkillUploadBody,
    username: string,
  ): Promise<{ name: string; version: string; status: string }> {
    const name = text(body?.name);
    if (!name) throw new ApiError('VALIDATION', '技能名必填');
    if (!isAppId(name)) {
      throw new ApiError('INVALID_APP_ID', '技能名不合法:必须是小写 kebab-case(2-64 字符)');
    }
    const version = text(body?.version) || '1.0.0';
    if (!isVersion(version)) {
      throw new ApiError('VALIDATION', '版本号不合法:必须是 x.y.z(可带 -rc.1 预发布后缀)');
    }
    const payload = this.decodeArchive(body?.archive);

    const existingApp = await getApp(this.db, KIND, name);
    if (existingApp && existingApp.channel === CHANNEL_MARKET) {
      throw new ApiError('CONFLICT', '名称与市场技能冲突,请先处理市场技能或驳回该共享技能');
    }
    // 版本行是永久占位（唯一约束覆盖软删行），重复上传同一版本一律冲突。
    if (await getRelease(this.db, KIND, name, version)) {
      throw new ApiError('CONFLICT', '该版本已存在');
    }

    const displayName = text(body?.display_name) || name;
    const description = text(body?.description);
    const author = text(body?.author) || username;
    const checksum = checksumOf(payload);

    await upsertApp(this.db, {
      kind: KIND,
      appId: name,
      title: displayName,
      description,
      owner: username,
      channel: CHANNEL_ORG,
    });
    await createRelease(this.db, {
      kind: KIND,
      appId: name,
      version,
      title: displayName,
      description,
      author,
      publisher: username,
      checksum,
      archive: payload,
      status: STATUS_PENDING,
    });
    await this.audit.log(username, 'shared_skill_upload', `${name}@${version}`);
    return { name, version, status: STATUS_PENDING };
  }

  private buildPayload(release: AppRelease): ArchivePayload {
    if (!release.archive || release.archive.length === 0) {
      throw new ApiError('INTERNAL', '归档数据缺失');
    }
    return {
      payload: release.archive,
      filename: archiveFilename(release.appId, release.version, release.archive),
      contentType: isZip(release.archive) ? 'application/zip' : 'application/gzip',
      version: release.version,
      checksum: release.checksum || checksumOf(release.archive),
    };
  }

  /** 员工面下载：已通过 + 已分发 +（管理员 / 本人 / 被授权）。 */
  async downloadForEmployee(
    name: string,
    version: string,
    username: string,
    role: string,
    userId: number,
  ): Promise<ArchivePayload> {
    const app = await getApp(this.db, KIND, name);
    if (!app || app.channel !== CHANNEL_ORG) throw new ApiError('NOT_FOUND', '技能不存在');
    const release = await getRelease(this.db, KIND, name, version);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', '技能不存在');
    if (release.status !== STATUS_APPROVED) throw new ApiError('NOT_FOUND', '技能不存在');
    const dist = await appDistribution(this.db, KIND, name);
    if (!delivered(dist)) throw new ApiError('NOT_FOUND', '技能不存在');
    if (!this.adminFull(role) && !ownedBy(dist, username)) {
      const groupsOfUser = await resolveUserEffectiveGroups(this.db, userId);
      const names = await accessibleAppIds(this.db, KIND, username, groupsOfUser);
      const hit = names.some((item) => item.toLowerCase() === name.toLowerCase());
      if (!hit) throw new ApiError('NOT_FOUND', '技能不存在');
    }
    const result = this.buildPayload(release);
    await incrementReleaseDownload(this.db, KIND, name, version);
    return result;
  }

  /** 管理面下载：任意审核状态，跳过可见性门。 */
  async download(name: string, version: string): Promise<ArchivePayload> {
    await this.requireOrgSkill(name);
    const release = await getRelease(this.db, KIND, name, version);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', '技能不存在');
    const result = this.buildPayload(release);
    await incrementReleaseDownload(this.db, KIND, name, version);
    return result;
  }

  async preview(name: string, version: string): Promise<SharedSkillPreviewJSON> {
    await this.requireOrgSkill(name);
    const release = await getRelease(this.db, KIND, name, version);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', '技能不存在');
    if (!release.archive || !isZip(release.archive)) return { files: [], skill_md: '' };
    return {
      files: listArchiveEntries(release.archive),
      skill_md: readArchiveText(release.archive, 'SKILL.md', MAX_PREVIEW_BYTES),
    };
  }

  async file(name: string, version: string, rawPath: string): Promise<SharedSkillFileJSON> {
    await this.requireOrgSkill(name);
    const target = text(rawPath).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!target) throw new ApiError('VALIDATION', '缺少文件路径');
    const release = await getRelease(this.db, KIND, name, version);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', '技能不存在');
    if (!release.archive || !isZip(release.archive)) throw new ApiError('NOT_FOUND', '文件不存在');
    const found = readArchiveEntry(release.archive, target, MAX_PREVIEW_BYTES);
    if (!found) throw new ApiError('NOT_FOUND', '文件不存在');
    return { path: target, ...found };
  }

  private async marketSkillExists(name: string): Promise<boolean> {
    const app = await getApp(this.db, KIND, name);
    return Boolean(app && app.channel === CHANNEL_MARKET);
  }

  /** 审核通过：市场名冲突 → 下架 → 归档已清理 → 状态机。 */
  async approve(name: string, version: string, username: string): Promise<{ ok: true }> {
    await this.requireOrgSkill(name);
    const release = await getRelease(this.db, KIND, name, version);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', '技能不存在');
    if (await this.marketSkillExists(name)) {
      throw new ApiError('CONFLICT', '名称与市场技能冲突,请先处理市场技能或驳回该共享技能');
    }
    const dist = await appDistribution(this.db, KIND, name);
    if (!writable(dist)) {
      throw new ApiError('APP_DELISTED', '该技能已下架，无法通过审核：请先重新上架再审核');
    }
    const outcome = await setReleaseStatusForReview(this.db, KIND, name, version, 'approved');
    if (outcome === 'not_found') throw new ApiError('NOT_FOUND', '技能不存在');
    if (outcome === 'archive_cleared') {
      throw new ApiError(
        'ARCHIVE_CLEARED',
        '该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本',
      );
    }
    await this.audit.log(username, 'shared_skill_approve', `${name}@${version}`);
    return { ok: true };
  }

  async reject(name: string, version: string, rawReason: string, username: string): Promise<{ ok: true }> {
    const reason = text(rawReason);
    if (!reason) throw new ApiError('VALIDATION', REASON_MISSING);
    if ([...reason].length > MAX_REASON_LEN) throw new ApiError('VALIDATION', REASON_TOO_LONG);
    await this.requireOrgSkill(name);
    const release = await getRelease(this.db, KIND, name, version);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', '技能不存在');
    const outcome = await setReleaseStatusForReview(this.db, KIND, name, version, 'rejected', reason);
    if (outcome === 'not_found') throw new ApiError('NOT_FOUND', '技能不存在');
    if (outcome === 'approved_not_rejectable') {
      throw new ApiError('APPROVED_NOT_REJECTABLE', '已审核通过的版本不可驳回');
    }
    await this.audit.log(username, 'shared_skill_reject', `${name}@${version}`);
    return { ok: true };
  }

  /** 删除单个版本：软删（保留版本占位与历史），最后一个版本没了就清授权。 */
  async deleteVersion(name: string, version: string, username: string): Promise<{ ok: true }> {
    await this.requireOrgSkill(name);
    const ok = await softDeleteRelease(this.db, KIND, name, version);
    if (!ok) throw new ApiError('NOT_FOUND', '技能不存在');
    await this.audit.log(username, 'shared_skill_delete', `${name}@${version}`);
    const remaining = (await listReleases(this.db, KIND, name)).filter((row) => !row.deletedAt);
    if (remaining.length === 0) await deleteAppGrants(this.db, KIND, name);
    return { ok: true };
  }

  async setQuality(
    name: string,
    version: string,
    rawQuality: string,
    username: string,
  ): Promise<{ ok: true; quality: string }> {
    const quality = text(rawQuality);
    if (!QUALITY_FLAGS.has(quality)) {
      throw new ApiError('VALIDATION', '质量标记不合法(空/featured;官方已移交归属官方操作)');
    }
    await this.requireOrgSkill(name);
    const ok = await setReleaseQuality(this.db, KIND, name, version, quality);
    if (!ok) throw new ApiError('NOT_FOUND', '技能不存在或未通过审核');
    await this.audit.log(username, 'shared_skill_qualify', `${name}@${version}=${quality}`);
    return { ok: true, quality };
  }

  /** 启停（原 enabled 字段）：映射到 apps.enabled。 */
  async setEnabled(
    name: string,
    body: SharedSkillEnabledBody,
    username: string,
  ): Promise<{ ok: true; enabled: boolean }> {
    const enabled = body?.enabled;
    if (typeof enabled !== 'boolean') {
      throw new ApiError('VALIDATION', '请求体格式错误(需要 {"enabled": true|false})');
    }
    await this.requireOrgSkill(name);
    const ok = await setAppEnabled(this.db, KIND, name, enabled);
    if (!ok) throw new ApiError('NOT_FOUND', '技能不存在');
    await this.audit.log(username, enabled ? 'shared_skill_enable' : 'shared_skill_disable', name);
    return { ok: true, enabled };
  }

  async listGrants(name: string): Promise<SharedSkillGrantJSON[]> {
    await this.requireOrgSkill(name);
    return listAppGrants(this.db, KIND, name);
  }

  private async groupExists(name: string): Promise<boolean> {
    const rows = await this.db
      .select({ name: groups.name })
      .from(groups)
      .where(sql`lower(${groups.name}) = ${name.toLowerCase()}`)
      .limit(1);
    return rows.length > 0;
  }

  private async userExists(name: string): Promise<boolean> {
    const rows = await this.db
      .select({ username: users.username })
      .from(users)
      .where(sql`lower(${users.username}) = ${name.toLowerCase()}`)
      .limit(1);
    return rows.length > 0;
  }

  /** 全量替换部门授权（大小写不敏感、去重）。 */
  async replaceGrants(
    name: string,
    rawGroups: string[] | undefined,
    username: string,
  ): Promise<{ ok: true }> {
    const source = Array.isArray(rawGroups) ? rawGroups : [];
    const names: string[] = [];
    const seen = new Set<string>();
    for (const item of source) {
      const normalized = normalizeGrantee(typeof item === 'string' ? item : '');
      if (!normalized) throw new ApiError('VALIDATION', '部门名不合法或不存在');
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(normalized);
    }
    await this.requireOrgSkill(name);
    const outcome = await replaceGroupGrants(this.db, KIND, name, names, (group) =>
      this.groupExists(group),
    );
    if (outcome !== 'ok') throw new ApiError('VALIDATION', '部门名不合法或不存在');
    await this.audit.log(username, 'shared_skill_grant', name);
    return { ok: true };
  }

  private subjectOf(body: SharedSkillGrantBody): { grantee: string; type: 'user' | 'group' } {
    const granteeName = text(body?.username);
    const groupName = text(body?.group);
    if (!granteeName && !groupName) throw new ApiError('VALIDATION', '缺少授权主体');
    const grantee = normalizeGrantee(granteeName || groupName);
    if (!grantee) throw new ApiError('VALIDATION', '授权主体不合法');
    return { grantee, type: granteeName ? 'user' : 'group' };
  }

  async grant(name: string, body: SharedSkillGrantBody, username: string): Promise<{ ok: true }> {
    const subject = this.subjectOf(body);
    await this.requireOrgSkill(name);
    const exists =
      subject.type === 'user'
        ? await this.userExists(subject.grantee)
        : await this.groupExists(subject.grantee);
    if (!exists) throw new ApiError('VALIDATION', '授权主体不存在');
    const ok = await grantApp(this.db, KIND, name, subject.grantee, subject.type);
    if (!ok) throw new ApiError('VALIDATION', '授权主体不合法');
    await this.audit.log(username, 'shared_skill_grant', `${name}@${subject.type}:${subject.grantee}`);
    return { ok: true };
  }

  async revoke(name: string, body: SharedSkillGrantBody, username: string): Promise<{ ok: true }> {
    const subject = this.subjectOf(body);
    await this.requireOrgSkill(name);
    await revokeApp(this.db, KIND, name, subject.grantee, subject.type);
    await this.audit.log(username, 'shared_skill_revoke', `${name}@${subject.type}:${subject.grantee}`);
    return { ok: true };
  }
}
