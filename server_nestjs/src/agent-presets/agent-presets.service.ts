/**
 * 智能体预置（组织共享面，kind='agent' + channel='org'）。
 *
 * 数据模型：apps / app_releases / app_grants（旧 agent_presets、agent_preset_grants 已下线）。
 * 语义与 Go 端 internal/serverstore/agent_presets.go + internal/agentshare/routes.go 对齐：
 *  - 员工面列表只发 org 通道「已通过审核 + 已分发」的版本；
 *  - 「我的」= 自己 App 的全部版本（忽略审核状态与下架）；
 *  - 无版本号的接口取「最高已通过版本，否则最新版本」（latestPresetRelease）；
 *  - 审核（无版本号）取「最高未通过版本，否则最新版本」（GetAgentPresetForReview）；
 *  - 整名删除 = 软删全部版本 + 清授权，**不删 apps 行**（app_releases 外键 ON DELETE
 *    CASCADE，硬删会连带删掉版本历史）。
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { appReleases, groups, users, type App, type AppRelease } from '../db/schema';
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
  currentRelease,
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
import { isGzip, isZip, listArchiveEntries, readArchiveEntry, readArchiveText } from '../shared-skills/zip-archive';

const KIND = 'agent' as const;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_REASON_LEN = 500;
/** 单文件预览上限（Go presetFileContent 为 1MB）。 */
const MAX_FILE_BYTES = 1024 * 1024;
/** preset.yml 展示上限（复用 128KB 的 SKILL.md 口径，防大文件回显）。 */
const MAX_MANIFEST_BYTES = 128 * 1024;
const QUALITY_FLAGS = new Set(['', 'featured']);
const REASON_MISSING = '请填写拒绝理由';
const REASON_TOO_LONG = '拒绝理由过长(上限 500 字)';
const PRESET_MISSING = '预设不存在';
const NOT_REJECTABLE = '已审核通过的版本不可驳回';

/** 智能体预置 JSON（snake_case，与 Go presetJSON 逐字段对齐；无 calls）。 */
export interface PresetJSON {
  name: string;
  display_name: string;
  description: string;
  version: string;
  author: string;
  status: string;
  reason: string;
  quality: string;
  downloads: number;
  created_at: string;
  updated_at: string;
}

export interface PresetGrantJSON {
  grantee_type: 'user' | 'group';
  grantee: string;
}

export interface ArchivePayload {
  payload: Buffer;
  filename: string;
  contentType: string;
  version: string;
  checksum: string;
}

export interface PresetPreviewJSON {
  files: Array<{ path: string; size: number }>;
  composition: string;
}

export interface PresetFileJSON {
  path: string;
  size: number;
  binary: boolean;
  too_large: boolean;
  content: string;
}

export interface PresetUploadBody {
  name?: unknown;
  display_name?: unknown;
  version?: unknown;
  description?: unknown;
  author?: unknown;
  archive?: unknown;
}

export interface PresetGrantBody {
  username?: unknown;
  group?: unknown;
}

export interface PresetEnabledBody {
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
export class AgentPresetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  private adminFull(role: string): boolean {
    return role === 'super_admin' || role === 'auditor';
  }

  private toJSON(release: AppRelease, app: App | null): PresetJSON {
    const displayName = text(app?.title) || release.appId;
    const description = text(app?.description) || (release.description ?? '');
    return {
      name: release.appId,
      display_name: displayName,
      description,
      version: release.version,
      // Go 投影：Author 取 publisher（上传账号），老数据可能只有 author。
      author: release.publisher || release.author || '',
      status: release.status,
      reason: release.reason ?? '',
      quality: release.quality ?? '',
      downloads: Number(release.downloads ?? 0),
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

  private async requireOrgAgent(name: string): Promise<App> {
    const app = await getApp(this.db, KIND, name);
    if (!app || app.channel !== CHANNEL_ORG) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    return app;
  }

  private async orgApps(): Promise<Map<string, App>> {
    const rows = await listApps(this.db, KIND, CHANNEL_ORG);
    return new Map(rows.map((app) => [app.appId, app]));
  }

  /** 未软删的版本（按 createdAt/id 升序，与 listReleases 一致）。 */
  private async liveReleases(name: string): Promise<AppRelease[]> {
    const rows = await listReleases(this.db, KIND, name);
    return rows.filter((row) => !row.deletedAt);
  }

  /** latestPresetRelease：最高已通过版本，否则最新版本。 */
  private async displayVersion(name: string): Promise<string> {
    const current = await currentRelease(this.db, KIND, name);
    if (current) return current.version;
    const rows = await this.liveReleases(name);
    if (rows.length === 0) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    const newest = rows.reduce((left, right) =>
      right.createdAt.getTime() > left.createdAt.getTime() ||
      (right.createdAt.getTime() === left.createdAt.getTime() && Number(right.id) > Number(left.id))
        ? right
        : left,
    );
    return newest.version;
  }

  /** GetAgentPresetForReview：最高未通过版本，否则最新版本。 */
  private async reviewTarget(name: string): Promise<string> {
    const rows = (await this.liveReleases(name)).filter((row) => row.status !== STATUS_APPROVED);
    if (rows.length === 0) return this.displayVersion(name);
    rows.sort((left, right) => compareVersions(right.version, left.version));
    return rows[0].version;
  }

  /** 员工面可见预置：已通过审核 + 已分发 +（管理员 / 本人 / 被授权）。 */
  async listVisibleForEmployee(
    username: string,
    role: string,
    userId: number,
  ): Promise<Array<PresetJSON & { enabled: boolean }>> {
    const appsById = await this.orgApps();
    if (appsById.size === 0) return [];
    const states = await distributionStates(this.db, KIND);
    let granted: Set<string> | null = null;
    if (!this.adminFull(role)) {
      const groupsOfUser = await resolveUserEffectiveGroups(this.db, userId);
      const names = await accessibleAppIds(this.db, KIND, username, groupsOfUser);
      granted = new Set(names.map((item) => item.toLowerCase()));
    }
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
  async listOwned(username: string): Promise<PresetJSON[]> {
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
  async listAll(status?: string): Promise<PresetJSON[]> {
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
    body: PresetUploadBody,
    username: string,
  ): Promise<{ name: string; version: string; status: string }> {
    const name = text(body?.name);
    if (!name) throw new ApiError('VALIDATION', '预设名必填');
    if (!isAppId(name)) {
      throw new ApiError('INVALID_APP_ID', '预设名不合法:必须是小写 kebab-case(2-64 字符)');
    }
    const version = text(body?.version) || '1.0.0';
    if (!isVersion(version)) {
      throw new ApiError('VALIDATION', '版本号不合法:必须是 x.y.z(可带 -rc.1 预发布后缀)');
    }
    const payload = this.decodeArchive(body?.archive);

    const existingApp = await getApp(this.db, KIND, name);
    if (existingApp && existingApp.channel === CHANNEL_MARKET) {
      throw new ApiError('CONFLICT', '名称与市场智能体冲突,请先处理市场智能体或驳回该预设');
    }
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
    await this.audit.log(username, 'agent_preset_upload', `${name}@${version}`);
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

  /**
   * 员工面下载（与 Go serveArchive 对齐）：已通过审核 + 已分发 +（本人 / 被授权）。
   * 与列表不同，这里同时服务 org 与 market 通道（Go 安装路径如此）。
   */
  async downloadForEmployee(
    name: string,
    version: string | undefined,
    username: string,
    role: string,
    userId: number,
  ): Promise<ArchivePayload> {
    const app = await getApp(this.db, KIND, name);
    if (!app) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    const target = version ?? (await this.displayVersion(name));
    const release = await getRelease(this.db, KIND, name, target);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    if (release.status !== STATUS_APPROVED) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    const dist = await appDistribution(this.db, KIND, name);
    if (!delivered(dist)) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    if (!this.adminFull(role) && !ownedBy(dist, username)) {
      const groupsOfUser = await resolveUserEffectiveGroups(this.db, userId);
      const names = await accessibleAppIds(this.db, KIND, username, groupsOfUser);
      const hit = names.some((item) => item.toLowerCase() === name.toLowerCase());
      if (!hit) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    }
    const result = this.buildPayload(release);
    await incrementReleaseDownload(this.db, KIND, name, target);
    return result;
  }

  /** 管理面下载：org 通道任意审核状态，跳过可见性门。 */
  async download(name: string, version?: string): Promise<ArchivePayload> {
    await this.requireOrgAgent(name);
    const target = version ?? (await this.displayVersion(name));
    const release = await getRelease(this.db, KIND, name, target);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    const result = this.buildPayload(release);
    await incrementReleaseDownload(this.db, KIND, name, target);
    return result;
  }

  private async previewOf(name: string, version?: string): Promise<PresetPreviewJSON> {
    await this.requireOrgAgent(name);
    const target = version ?? (await this.displayVersion(name));
    const release = await getRelease(this.db, KIND, name, target);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    if (!release.archive || !isZip(release.archive)) return { files: [], composition: '' };
    return {
      files: listArchiveEntries(release.archive),
      composition: readArchiveText(release.archive, 'preset.yml', MAX_MANIFEST_BYTES),
    };
  }

  async preview(name: string): Promise<PresetPreviewJSON> {
    return this.previewOf(name);
  }

  async previewVersion(name: string, version: string): Promise<PresetPreviewJSON> {
    return this.previewOf(name, version);
  }

  private async fileOf(
    name: string,
    version: string | undefined,
    rawPath: string,
  ): Promise<PresetFileJSON> {
    await this.requireOrgAgent(name);
    const target = text(rawPath).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!target) throw new ApiError('VALIDATION', '缺少文件路径');
    const versionTarget = version ?? (await this.displayVersion(name));
    const release = await getRelease(this.db, KIND, name, versionTarget);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    if (!release.archive || !isZip(release.archive)) throw new ApiError('NOT_FOUND', '文件不存在');
    const found = readArchiveEntry(release.archive, target, MAX_FILE_BYTES);
    if (!found) throw new ApiError('NOT_FOUND', '文件不存在');
    return { path: target, ...found };
  }

  async file(name: string, version: string | undefined, path: string): Promise<PresetFileJSON> {
    return this.fileOf(name, version, path);
  }

  private async marketAgentExists(name: string): Promise<boolean> {
    const app = await getApp(this.db, KIND, name);
    return Boolean(app && app.channel === CHANNEL_MARKET);
  }

  private async approveTarget(name: string, version: string, username: string): Promise<{ ok: true }> {
    await this.requireOrgAgent(name);
    const release = await getRelease(this.db, KIND, name, version);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    if (await this.marketAgentExists(name)) {
      throw new ApiError('CONFLICT', '名称与市场智能体冲突,请先处理市场智能体或驳回该预设');
    }
    const dist = await appDistribution(this.db, KIND, name);
    if (!writable(dist)) {
      throw new ApiError('APP_DELISTED', '该智能体已下架，无法通过审核：请先重新上架再审核');
    }
    const outcome = await setReleaseStatusForReview(this.db, KIND, name, version, 'approved');
    if (outcome === 'not_found') throw new ApiError('NOT_FOUND', PRESET_MISSING);
    if (outcome === 'archive_cleared') {
      throw new ApiError(
        'ARCHIVE_CLEARED',
        '该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本',
      );
    }
    await this.audit.log(username, 'agent_preset_approve', `${name}@${version}`);
    return { ok: true };
  }

  /** 无版本号审核：对 reviewTarget（最高未通过版本）操作。 */
  async approve(name: string, username: string): Promise<{ ok: true }> {
    await this.requireOrgAgent(name);
    const target = await this.reviewTarget(name);
    return this.approveTarget(name, target, username);
  }

  async approveVersion(name: string, version: string, username: string): Promise<{ ok: true }> {
    return this.approveTarget(name, version, username);
  }

  private validateReason(rawReason: string): string {
    const reason = text(rawReason);
    if (!reason) throw new ApiError('VALIDATION', REASON_MISSING);
    if ([...reason].length > MAX_REASON_LEN) throw new ApiError('VALIDATION', REASON_TOO_LONG);
    return reason;
  }

  private async rejectTarget(
    name: string,
    version: string,
    reason: string,
    username: string,
  ): Promise<{ ok: true }> {
    await this.requireOrgAgent(name);
    const release = await getRelease(this.db, KIND, name, version);
    if (!release || release.deletedAt) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    const outcome = await setReleaseStatusForReview(this.db, KIND, name, version, 'rejected', reason);
    if (outcome === 'not_found') throw new ApiError('NOT_FOUND', PRESET_MISSING);
    if (outcome === 'approved_not_rejectable') {
      throw new ApiError('APPROVED_NOT_REJECTABLE', NOT_REJECTABLE);
    }
    await this.audit.log(username, 'agent_preset_reject', `${name}@${version}`);
    return { ok: true };
  }

  async reject(name: string, rawReason: string, username: string): Promise<{ ok: true }> {
    const reason = this.validateReason(rawReason);
    await this.requireOrgAgent(name);
    const target = await this.reviewTarget(name);
    return this.rejectTarget(name, target, reason, username);
  }

  async rejectVersion(
    name: string,
    version: string,
    rawReason: string,
    username: string,
  ): Promise<{ ok: true }> {
    const reason = this.validateReason(rawReason);
    return this.rejectTarget(name, version, reason, username);
  }

  /** 整名删除：软删全部未删版本 + 清授权（apps 行保留，见文件头注释）。 */
  async deleteAll(name: string, username: string): Promise<{ ok: true }> {
    await this.requireOrgAgent(name);
    const rows = await this.liveReleases(name);
    if (rows.length === 0) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    const now = new Date();
    await this.db
      .update(appReleases)
      .set({ deletedAt: now, archive: null, size: 0, updatedAt: now })
      .where(
        and(
          eq(appReleases.kind, KIND),
          eq(appReleases.appId, name),
          isNull(appReleases.deletedAt),
        ),
      );
    await deleteAppGrants(this.db, KIND, name);
    await this.audit.log(username, 'agent_preset_delete', name);
    return { ok: true };
  }

  async deleteVersion(name: string, version: string, username: string): Promise<{ ok: true }> {
    await this.requireOrgAgent(name);
    const ok = await softDeleteRelease(this.db, KIND, name, version);
    if (!ok) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    await this.audit.log(username, 'agent_preset_delete', `${name}@${version}`);
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
    await this.requireOrgAgent(name);
    const ok = await setReleaseQuality(this.db, KIND, name, version, quality);
    if (!ok) throw new ApiError('NOT_FOUND', '预设不存在或未通过审核');
    await this.audit.log(username, 'agent_preset_qualify', `${name}@${version}=${quality}`);
    return { ok: true, quality };
  }

  async setEnabled(
    name: string,
    body: PresetEnabledBody,
    username: string,
  ): Promise<{ ok: true; enabled: boolean }> {
    const enabled = body?.enabled;
    if (typeof enabled !== 'boolean') {
      throw new ApiError('VALIDATION', '请求体格式错误(需要 {"enabled": true|false})');
    }
    await this.requireOrgAgent(name);
    const ok = await setAppEnabled(this.db, KIND, name, enabled);
    if (!ok) throw new ApiError('NOT_FOUND', PRESET_MISSING);
    await this.audit.log(username, enabled ? 'agent_preset_enable' : 'agent_preset_disable', name);
    return { ok: true, enabled };
  }

  async listGrants(name: string): Promise<PresetGrantJSON[]> {
    await this.requireOrgAgent(name);
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
    await this.requireOrgAgent(name);
    const outcome = await replaceGroupGrants(this.db, KIND, name, names, (group) =>
      this.groupExists(group),
    );
    if (outcome !== 'ok') throw new ApiError('VALIDATION', '部门名不合法或不存在');
    await this.audit.log(username, 'agent_preset_grant', name);
    return { ok: true };
  }

  private subjectOf(body: PresetGrantBody): { grantee: string; type: 'user' | 'group' } {
    const granteeName = text(body?.username);
    const groupName = text(body?.group);
    if (!granteeName && !groupName) throw new ApiError('VALIDATION', '缺少授权主体');
    const grantee = normalizeGrantee(granteeName || groupName);
    if (!grantee) throw new ApiError('VALIDATION', '授权主体不合法');
    return { grantee, type: granteeName ? 'user' : 'group' };
  }

  async grant(name: string, body: PresetGrantBody, username: string): Promise<{ ok: true }> {
    const subject = this.subjectOf(body);
    await this.requireOrgAgent(name);
    const exists =
      subject.type === 'user'
        ? await this.userExists(subject.grantee)
        : await this.groupExists(subject.grantee);
    if (!exists) throw new ApiError('VALIDATION', '授权主体不存在');
    const ok = await grantApp(this.db, KIND, name, subject.grantee, subject.type);
    if (!ok) throw new ApiError('VALIDATION', '授权主体不合法');
    await this.audit.log(username, 'agent_preset_grant', `${name}@${subject.type}:${subject.grantee}`);
    return { ok: true };
  }

  async revoke(name: string, body: PresetGrantBody, username: string): Promise<{ ok: true }> {
    const subject = this.subjectOf(body);
    await this.requireOrgAgent(name);
    await revokeApp(this.db, KIND, name, subject.grantee, subject.type);
    await this.audit.log(username, 'agent_preset_revoke', `${name}@${subject.type}:${subject.grantee}`);
    return { ok: true };
  }
}
