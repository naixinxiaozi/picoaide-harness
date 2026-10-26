import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import {
  appReleases,
  groups,
  users,
  type App,
  type AppKind,
  type GranteeType,
} from '../db/schema';
import {
  CHANNEL_MARKET,
  STATUS_APPROVED,
  accessibleAppIds,
  appDistribution,
  compareVersions,
  createRelease,
  delivered,
  distributionOf,
  distributionStates,
  getApp,
  getRelease,
  grantApp,
  incrementReleaseDownload,
  listAppGrants,
  listApps,
  ownedBy,
  replaceGroupGrants,
  revokeApp,
  setAppEnabled,
  upsertApp,
  writable,
} from '../common/apps-shared';
import { ApiError, type ErrorCode } from '../common/errors/api-error';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { resolveUserEffectiveGroups } from '../common/effective-groups';
import { rfc3339UTC } from '../common/time';
import { isAppId, isVersion, normalizeGrantee } from '../common/skills-shared';

/**
 * 技能 / 市场智能体服务（统一应用模型：apps + app_releases + app_grants）。
 *
 * 语义权威：server/internal/serverstore/{apps,skills,agent_presets,grants,
 * distribution}.go 与 server/internal/marketplace/{handlers,skill_api,
 * agent_api,admin}.go。旧表（skills / shared_skills / agent_presets /
 * skill_grants / agent_preset_grants）已在迁移 0055 删除。
 *
 * 口径摘要：
 * - 技能商城 = kind='skill' 且 channel='market'；市场智能体 = kind='agent'
 *   且 channel='market'（组织共享库是 channel='org'，同名跨通道互斥）。
 * - 「展示版本」= 最高 approved 且未软删的 release（Go currentRelease）；
 *   创建 App 本身不产生版本，版本只由归档上传产生（不可变快照）。
 * - 员工面可见性 = 已上架未删 ∧（管理员 ∨ 归属人 ∨ user/部门授权），
 *   不满足一律 404（不泄露存在性），且授权判定先于下架判定。
 */

/** 商城技能 JSON（snake_case，与 Go skillJSON 逐字段对齐）。 */
export interface SkillJSON {
  id: number;
  name: string;
  version: string;
  description: string;
  author: string;
  checksum: string;
  enabled: boolean;
  downloads: number;
  calls: number;
  official: boolean;
  created_at: string;
  updated_at: string;
}

/** 商城智能体 JSON（市场通道，与 Go agentJSON 逐字段对齐）。 */
export interface AgentJSON {
  name: string;
  title: string;
  description: string;
  author: string;
  enabled: boolean;
  official: boolean;
  created_at: string;
  updated_at: string;
  version: string;
  quality: string;
  downloads: number;
  changelog: string;
}

export interface GrantJSON {
  grantee_type: 'user' | 'group';
  grantee: string;
}

/** 归档字节流（控制器负责写头 + 写体）。 */
export interface ArchivePayload {
  archive: Buffer;
  version: string;
  checksum: string;
  filename: string;
  contentType: string;
}

/** 展示版本所需列（不取 archive，避免列表路径把 bytea 全读出来）。 */
interface ShownRelease {
  id: number;
  version: string;
  title: string;
  description: string;
  changelog: string;
  quality: string;
  checksum: string;
  downloads: number;
  calls: number;
}

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024; // 16 MiB

const KIND_LABEL: Record<AppKind, string> = { skill: '技能', agent: '智能体' };

/**
 * Go 契约错误码 VERSION_EXISTS（同名同版本冲突）。
 * shared ERROR_CODES 目前未登记该码，而本文件范围不允许扩公共枚举，
 * 故在此显式桥接；登记进 common/errors 后可直接替换为字面量。
 */
const ERR_VERSION_EXISTS = 'VERSION_EXISTS' as unknown as ErrorCode;

@Injectable()
export class MarketplaceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  // ------------------------------------------------------------------ helpers

  /** 技能投影：App 层优先，版本字段取展示版本（Go appToSkill）。 */
  private toSkillJSON(a: App, r: ShownRelease | null): SkillJSON {
    return {
      id: r?.id ?? 0,
      name: a.appId,
      version: r?.version ?? '',
      description: a.description || (r?.description ?? ''),
      author: a.owner,
      checksum: r?.checksum ?? '',
      enabled: a.enabled === 1,
      downloads: r?.downloads ?? 0,
      calls: r?.calls ?? 0,
      official: a.official === 1,
      created_at: rfc3339UTC(a.createdAt),
      updated_at: rfc3339UTC(a.updatedAt),
    };
  }

  /** 智能体投影（Go agentJSON）：无展示版本时版本相关字段为空。 */
  private toAgentJSON(a: App, r: ShownRelease | null): AgentJSON {
    return {
      name: a.appId,
      title: a.title,
      description: a.description,
      author: a.owner,
      enabled: a.enabled === 1,
      official: a.official === 1,
      created_at: rfc3339UTC(a.createdAt),
      updated_at: rfc3339UTC(a.updatedAt),
      version: r?.version ?? '',
      quality: r?.quality ?? '',
      downloads: r?.downloads ?? 0,
      changelog: r?.changelog ?? '',
    };
  }

  /** 员工面当前用户是否视为「管理全量」（super_admin / auditor）。 */
  private adminFull(role: string): boolean {
    return role === 'super_admin' || role === 'auditor';
  }

  /**
   * 某 kind 的展示版本集合：未软删 + approved，每个 appId 取最高版本。
   * 只选投影需要的列（archive 是 bytea，列表路径绝不能顺带读出来）。
   */
  private async shownReleases(
    kind: AppKind,
    appId?: string,
  ): Promise<Map<string, ShownRelease>> {
    const where = appId
      ? and(eq(appReleases.kind, kind), eq(appReleases.appId, appId))
      : eq(appReleases.kind, kind);
    const rows = await this.db
      .select({
        id: appReleases.id,
        appId: appReleases.appId,
        version: appReleases.version,
        title: appReleases.title,
        description: appReleases.description,
        changelog: appReleases.changelog,
        quality: appReleases.quality,
        checksum: appReleases.checksum,
        downloads: appReleases.downloads,
        calls: appReleases.calls,
        status: appReleases.status,
        deletedAt: appReleases.deletedAt,
      })
      .from(appReleases)
      .where(where);
    const out = new Map<string, ShownRelease>();
    for (const r of rows) {
      if (r.deletedAt || r.status !== STATUS_APPROVED) continue;
      const cur = out.get(r.appId);
      if (!cur || compareVersions(r.version, cur.version) > 0) {
        out.set(r.appId, {
          id: r.id,
          version: r.version,
          title: r.title,
          description: r.description,
          changelog: r.changelog,
          quality: r.quality,
          checksum: r.checksum,
          downloads: r.downloads,
          calls: r.calls,
        });
      }
    }
    return out;
  }

  private async shownRelease(
    kind: AppKind,
    appId: string,
  ): Promise<ShownRelease | null> {
    return (await this.shownReleases(kind, appId)).get(appId) ?? null;
  }

  /** 市场通道 App 守卫（不存在 / 非 market 均按「不存在」处理，不泄露跨通道行）。 */
  private async ensureMarketApp(kind: AppKind, appId: string): Promise<App> {
    const app = await getApp(this.db, kind, appId);
    if (!app || app.channel !== CHANNEL_MARKET) {
      throw new ApiError('NOT_FOUND', `${KIND_LABEL[kind]}不存在`);
    }
    return app;
  }

  /** 解码 + 校验归档 base64，返回原始字节与 sha256。 */
  private decodeArchive(archive: unknown): { buf: Buffer; checksum: string } {
    if (typeof archive !== 'string' || archive.length === 0) {
      throw new ApiError('VALIDATION', '归档编码错误或为空', 400);
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(archive, 'base64');
      // 非法 base64 会被 Buffer 宽松解码，这里做一次严格回编校验。
      if (buf.toString('base64').replace(/=+$/, '') !== archive.replace(/=+$/, '')) {
        throw new Error('bad base64');
      }
    } catch {
      throw new ApiError('VALIDATION', '归档编码错误或为空', 400);
    }
    if (buf.length === 0) throw new ApiError('VALIDATION', '归档编码错误或为空', 400);
    if (buf.length > MAX_ARCHIVE_BYTES) {
      throw new ApiError('PAYLOAD_TOO_LARGE', '归档过大(上限 16MB)');
    }
    return { buf, checksum: this.crypto.sha256(buf.toString('binary')) };
  }

  /** 归档类型按魔数嗅探（Go serveSkillArchive 口径）。 */
  private archiveKind(buf: Buffer): { contentType: string; ext: string } {
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      return { contentType: 'application/gzip', ext: '.tar.gz' };
    }
    return { contentType: 'application/zip', ext: '.zip' };
  }

  /** 版本冲突错误（先查 + 唯一约束兜底）。 */
  private versionExists(version: string): ApiError {
    return new ApiError(
      ERR_VERSION_EXISTS,
      `版本 ${version} 已存在(每个版本都是不可修改的快照),请升版本号后重试`,
      409,
    );
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === '23505'
    );
  }

  /**
   * 发布一个版本（不可变快照，管理员上架 = 已审核 ⇒ status=approved）。
   * 同名同版本（含历史被拒/软删占位）一律冲突。
   */
  private async publishRelease(
    kind: AppKind,
    app: App,
    version: string,
    buf: Buffer,
    checksum: string,
    publisher: string,
  ): Promise<void> {
    if (await getRelease(this.db, kind, app.appId, version)) {
      throw this.versionExists(version);
    }
    const dist = await appDistribution(this.db, kind, app.appId);
    if (!writable(dist)) {
      throw new ApiError(
        'APP_DELISTED',
        `该${KIND_LABEL[kind]}已下架，暂不能发布新版本：请先联系管理员重新上架`,
        409,
      );
    }
    try {
      await createRelease(this.db, {
        kind,
        appId: app.appId,
        version,
        title: app.title,
        description: app.description,
        author: app.owner,
        publisher,
        checksum,
        archive: buf,
        status: STATUS_APPROVED,
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) throw this.versionExists(version);
      throw err;
    }
  }

  private parseGrantSubject(body: {
    username?: string;
    group?: string;
  }): { subject: string; granteeType: GranteeType } {
    const username = (body?.username ?? '').trim();
    const group = (body?.group ?? '').trim();
    if (!!username === !!group) {
      throw new ApiError('VALIDATION', 'username 或 group 必填且只能二选一', 400);
    }
    const subject = normalizeGrantee(username || group);
    if (!subject) throw new ApiError('VALIDATION', '授权对象不合法', 400);
    return { subject, granteeType: username ? 'user' : 'group' };
  }

  /** 授权主体大小写不敏感解析：返回库内规范写法（拼错的名字不静默落库）。 */
  private async canonicalGrantee(
    subject: string,
    granteeType: GranteeType,
  ): Promise<string> {
    if (granteeType === 'user') {
      const [row] = await this.db
        .select({ username: users.username })
        .from(users)
        .where(sql`lower(${users.username}) = ${subject.toLowerCase()}`)
        .limit(1);
      if (!row) {
        throw new ApiError('VALIDATION', `用户不存在: ${subject}`, 400);
      }
      return row.username;
    }
    const canonical = await this.canonicalGroup(subject);
    if (!canonical) {
      throw new ApiError('VALIDATION', `部门不存在: ${subject}`, 400);
    }
    return canonical;
  }

  /** 部门名大小写不敏感解析（返回库内规范写法；不存在 → null）。 */
  private async canonicalGroup(name: string): Promise<string | null> {
    const [row] = await this.db
      .select({ name: groups.name })
      .from(groups)
      .where(sql`lower(${groups.name}) = ${name.toLowerCase()}`)
      .limit(1);
    return row?.name ?? null;
  }

  /** 单条授权 / 撤销（market App 守卫 + 主体校验 + 审计）。 */
  private async applyGrant(
    kind: AppKind,
    appId: string,
    body: { username?: string; group?: string },
    actor: string,
    grant: boolean,
  ): Promise<void> {
    await this.ensureMarketApp(kind, appId);
    const { subject, granteeType } = this.parseGrantSubject(body);
    const canonical = await this.canonicalGrantee(subject, granteeType);
    const ok = grant
      ? await grantApp(this.db, kind, appId, canonical, granteeType)
      : await revokeApp(this.db, kind, appId, canonical, granteeType);
    if (!ok) throw new ApiError('VALIDATION', '授权对象不合法', 400);
    await this.audit.log(
      actor,
      `${kind}_${grant ? 'grant' : 'revoke'}`,
      `${appId}:${granteeType}:${canonical}`,
    );
  }

  /** 整组替换部门授权（用户授权保留；Go ReplaceSkillGroupGrants 口径）。 */
  private async replaceGroups(
    kind: AppKind,
    appId: string,
    rawGroups: unknown,
    actor: string,
  ): Promise<void> {
    await this.ensureMarketApp(kind, appId);
    if (!Array.isArray(rawGroups)) {
      throw new ApiError('VALIDATION', '请求体错误(仅接受 groups 字段)', 400);
    }
    const cleaned: string[] = [];
    for (const raw of rawGroups.map(String)) {
      const g = normalizeGrantee(raw);
      if (!g) throw new ApiError('VALIDATION', '部门名不合法或不存在', 400);
      const canonical = await this.canonicalGroup(g);
      if (!canonical) {
        throw new ApiError('VALIDATION', '存在不认识的部门名称', 400);
      }
      if (!cleaned.includes(canonical)) cleaned.push(canonical);
    }
    const result = await replaceGroupGrants(
      this.db,
      kind,
      appId,
      cleaned,
      async () => true,
    );
    if (result !== 'ok') {
      throw new ApiError('VALIDATION', '存在不认识的部门名称', 400);
    }
    await this.audit.log(
      actor,
      `${kind}_grants`,
      cleaned.length ? `${appId} ${cleaned.join(',')}` : appId,
    );
  }

  // ------------------------------------------------------------ skills (market)

  /** 管理面：全量商城技能（含下架）。 */
  async listSkills(): Promise<SkillJSON[]> {
    const [apps, shown] = await Promise.all([
      listApps(this.db, 'skill', CHANNEL_MARKET),
      this.shownReleases('skill'),
    ]);
    return apps.map((a) => this.toSkillJSON(a, shown.get(a.appId) ?? null));
  }

  /**
   * 员工面：已上架技能 + 授权（管理员全量；否则授权 ∪ 归属人）。
   * 授权判定用有效部门（含祖先/主管子树/全员组）。
   */
  async listMarketSkillsForEmployee(
    username: string,
    role: string,
    userId: number,
  ): Promise<SkillJSON[]> {
    const [apps, states, shown] = await Promise.all([
      listApps(this.db, 'skill', CHANNEL_MARKET),
      distributionStates(this.db, 'skill'),
      this.shownReleases('skill'),
    ]);
    const onShelf = apps.filter((a) =>
      delivered(distributionOf(states, a.appId)),
    );
    const project = (rows: App[]): SkillJSON[] =>
      rows.map((a) => this.toSkillJSON(a, shown.get(a.appId) ?? null));
    if (this.adminFull(role)) return project(onShelf);

    const groups = await resolveUserEffectiveGroups(this.db, userId);
    const granted = await accessibleAppIds(this.db, 'skill', username, groups);
    const allowed = new Set(granted);
    return project(
      onShelf.filter(
        (a) =>
          allowed.has(a.appId) ||
          ownedBy(distributionOf(states, a.appId), username),
      ),
    );
  }

  /** 员工面：单个技能；授权先于下架（未授权 404，不泄露存在性）。 */
  async getMarketSkill(
    name: string,
    username: string,
    role: string,
    userId: number,
  ): Promise<SkillJSON> {
    const app = await getApp(this.db, 'skill', name);
    if (!app || app.channel !== CHANNEL_MARKET) {
      throw new ApiError('NOT_FOUND', '技能不存在');
    }
    const dist = await appDistribution(this.db, 'skill', name);
    if (!this.adminFull(role)) {
      const groups = await resolveUserEffectiveGroups(this.db, userId);
      const granted = await accessibleAppIds(this.db, 'skill', username, groups);
      if (!granted.includes(name) && !ownedBy(dist, username)) {
        throw new ApiError('NOT_FOUND', '技能不存在');
      }
    }
    if (!delivered(dist)) throw new ApiError('NOT_FOUND', '技能已下架');
    return this.toSkillJSON(app, await this.shownRelease('skill', name));
  }

  /** 管理面：创建商城技能（只登记 App 身份，版本由归档上传产生）。 */
  async createSkill(body: {
    name?: string;
    version?: string;
    description?: string;
    author?: string;
  }): Promise<SkillJSON> {
    const name = (body?.name ?? '').trim();
    if (!name) throw new ApiError('VALIDATION', '名称必填', 400);
    if (!isAppId(name)) {
      throw new ApiError(
        'INVALID_APP_ID',
        '技能名不合法:必须是小写 kebab-case(如 my-skill)',
        400,
      );
    }
    const existing = await getApp(this.db, 'skill', name);
    if (existing) {
      // 决策 2026-08-25：市场与组织共享库同名互斥。
      if (existing.channel !== CHANNEL_MARKET) {
        throw new ApiError(
          'CONFLICT',
          '名称与组织共享库技能冲突,请先在共享库处理同名技能',
          409,
        );
      }
      throw new ApiError('VALIDATION', '技能已存在', 400);
    }
    const author = (body?.author ?? '').trim();
    await upsertApp(this.db, {
      kind: 'skill',
      appId: name,
      title: name,
      description: body?.description ?? '',
      owner: author,
      channel: CHANNEL_MARKET,
      enabled: 1,
    });
    await this.audit.log(author || 'admin', 'skill_create', name);
    return this.toSkillJSON(await this.ensureMarketApp('skill', name), null);
  }

  /** 管理面：更新技能元信息（版本与归属不在这里改）。 */
  async updateSkillMeta(
    name: string,
    body: { name?: string; version?: string; description?: string; author?: string },
  ): Promise<SkillJSON> {
    const app = await this.ensureMarketApp('skill', name);
    const shown = await this.shownRelease('skill', name);
    const currentVersion = shown?.version ?? '';
    if ((body?.version ?? '') !== '' && body.version !== currentVersion) {
      throw new ApiError(
        'VALIDATION',
        '请用「上传新版」随归档一起更改版本',
        400,
      );
    }
    if ((body?.author ?? '') !== '' && body.author !== app.owner) {
      throw new ApiError(
        'VALIDATION',
        '归属(负责人)不能在这里修改:它决定谁能续传新版本,请用「转移归属」',
        400,
      );
    }
    const title = (body?.name ?? '').trim();
    const description = body?.description ?? '';
    await upsertApp(this.db, {
      kind: 'skill',
      appId: name,
      title: title || app.title,
      description: description || app.description,
      owner: app.owner,
      channel: CHANNEL_MARKET,
      enabled: app.enabled,
    });
    await this.audit.log('admin', 'skill_update', name);
    return this.toSkillJSON(
      await this.ensureMarketApp('skill', name),
      await this.shownRelease('skill', name),
    );
  }

  /** 管理面：下架（只挡分发面，不删数据）。 */
  async disableSkill(name: string, username: string): Promise<void> {
    await this.setSkillEnabled(name, false);
    await this.audit.log(username, 'skill_disable', name);
  }

  /** 管理面：重新上架。 */
  async enableSkill(name: string, username: string): Promise<void> {
    await this.setSkillEnabled(name, true);
    await this.audit.log(username, 'skill_enable', name);
  }

  private async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    await this.ensureMarketApp('skill', name);
    const ok = await setAppEnabled(this.db, 'skill', name, enabled);
    if (!ok) throw new ApiError('NOT_FOUND', '技能不存在');
  }

  /** 管理面：上传新版归档（版本 = 不可变快照，管理员上传即已审核）。 */
  async uploadSkillArchive(
    name: string,
    body: { version?: string; archive?: unknown },
    username: string,
  ): Promise<{ version: string; checksum: string }> {
    const version = (body?.version ?? '').trim();
    const archive = body?.archive;
    if (!version || archive == null) {
      throw new ApiError('VALIDATION', 'version 与 archive 必填', 400);
    }
    if (!isAppId(name)) throw new ApiError('VALIDATION', '技能名不合法', 400);
    if (version.includes('/') || version.includes('\\') || !isVersion(version)) {
      throw new ApiError('VALIDATION', '版本不合法', 400);
    }
    const { buf, checksum } = this.decodeArchive(archive);
    const app = await this.ensureMarketApp('skill', name);
    await this.publishRelease('skill', app, version, buf, checksum, username);
    await this.audit.log(username, 'skill_update', `${name}@${version}`);
    return { version, checksum };
  }

  /** 管理面：技能预览（服务端不解析归档 → 空文件清单结构）。 */
  async previewSkill(name: string): Promise<{
    files: unknown[];
    skill_md: string;
    name: string;
    version: string;
    checksum: string;
  }> {
    const app = await this.ensureMarketApp('skill', name);
    const shown = await this.shownRelease('skill', name);
    return {
      files: [],
      skill_md: '',
      name: app.appId,
      version: shown?.version ?? '',
      checksum: shown?.checksum ?? '',
    };
  }

  /** 管理面：技能归档内文件读取（无归档解析器 → 空内容结构）。 */
  async skillFile(
    name: string,
    path: string,
  ): Promise<{ path: string; size: number; binary: boolean; too_large: boolean; content: string }> {
    await this.ensureMarketApp('skill', name);
    const p = (path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    return { path: p, size: 0, binary: false, too_large: false, content: '' };
  }

  /** 管理面：下载当前展示版本归档（不过分发闸门）。 */
  async downloadSkillArchive(name: string): Promise<ArchivePayload> {
    await this.ensureMarketApp('skill', name);
    const shown = await this.shownRelease('skill', name);
    if (!shown) throw new ApiError('NOT_FOUND', '技能尚未上传归档');
    const release = await getRelease(this.db, 'skill', name, shown.version);
    if (!release?.archive || release.archive.length === 0) {
      throw new ApiError('NOT_FOUND', '技能尚未上传归档');
    }
    const { contentType, ext } = this.archiveKind(release.archive);
    await incrementReleaseDownload(this.db, 'skill', name, shown.version);
    return {
      archive: release.archive,
      version: shown.version,
      checksum:
        release.checksum ||
        this.crypto.sha256(release.archive.toString('binary')),
      filename: `${name}-${shown.version}${ext}`,
      contentType,
    };
  }

  /** 管理面：规范化（服务端不改写归档 → 已合规结构）。 */
  async normalizeSkill(name: string): Promise<{
    version: string;
    checksum: string;
    changes: unknown[];
    already_compliant: boolean;
  }> {
    await this.ensureMarketApp('skill', name);
    const shown = await this.shownRelease('skill', name);
    return {
      version: shown?.version ?? '',
      checksum: shown?.checksum ?? '',
      changes: [],
      already_compliant: true,
    };
  }

  // ------------------------------------------------------------ skills grants

  async listSkillGrants(name: string): Promise<GrantJSON[]> {
    await this.ensureMarketApp('skill', name);
    return listAppGrants(this.db, 'skill', name);
  }

  async replaceSkillGrants(
    name: string,
    rawGroups: unknown,
    username: string,
  ): Promise<void> {
    await this.replaceGroups('skill', name, rawGroups, username);
  }

  async grantSkill(
    name: string,
    body: { username?: string; group?: string },
    username: string,
  ): Promise<void> {
    await this.applyGrant('skill', name, body, username, true);
  }

  async revokeSkillGrant(
    name: string,
    body: { username?: string; group?: string },
    username: string,
  ): Promise<void> {
    await this.applyGrant('skill', name, body, username, false);
  }

  // ------------------------------------------------------------ builtin

  /** 员工面：内置技能清单（无内置目录 → 空结构，全员登录可见）。 */
  async listBuiltin(): Promise<unknown[]> {
    return [];
  }

  /** 管理面：内置技能诊断（只读）。 */
  async builtinDiagnostic(): Promise<{
    dir: string;
    dir_exists: boolean;
    skills: unknown[];
    problems: unknown[];
    counts: { skills: number; problems: number };
  }> {
    return {
      dir: '',
      dir_exists: false,
      skills: [],
      problems: [],
      counts: { skills: 0, problems: 0 },
    };
  }

  // ------------------------------------------------------------ agents (market)

  /** 管理面：全量市场智能体（含下架）。 */
  async listAgents(): Promise<AgentJSON[]> {
    const [apps, shown] = await Promise.all([
      listApps(this.db, 'agent', CHANNEL_MARKET),
      this.shownReleases('agent'),
    ]);
    return apps.map((a) => this.toAgentJSON(a, shown.get(a.appId) ?? null));
  }

  /** 管理面：创建市场智能体（只登记 App 身份，版本由归档上传产生）。 */
  async createAgent(
    body: { name?: string; description?: string; author?: string },
    adminUsername: string,
  ): Promise<AgentJSON> {
    const name = (body?.name ?? '').trim();
    if (!name) throw new ApiError('VALIDATION', '名称必填', 400);
    if (!isAppId(name)) {
      throw new ApiError(
        'INVALID_APP_ID',
        '名称不合法:必须是小写 kebab-case(如 my-agent)',
        400,
      );
    }
    const existing = await getApp(this.db, 'agent', name);
    if (existing) {
      if (existing.channel !== CHANNEL_MARKET) {
        throw new ApiError(
          'CONFLICT',
          '名称与组织共享库智能体冲突,请先在共享库处理同名智能体',
          409,
        );
      }
      throw new ApiError('VALIDATION', '智能体已存在', 400);
    }
    const author = (body?.author ?? '').trim() || adminUsername;
    await upsertApp(this.db, {
      kind: 'agent',
      appId: name,
      title: name,
      description: body?.description ?? '',
      owner: author,
      channel: CHANNEL_MARKET,
      enabled: 1,
    });
    await this.audit.log(adminUsername, 'agent_create', name);
    return this.toAgentJSON(await this.ensureMarketApp('agent', name), null);
  }

  /** 管理面：更新市场智能体元信息（不碰归属）。 */
  async updateAgentMeta(
    name: string,
    body: { name?: string; description?: string; author?: string },
    username: string,
  ): Promise<void> {
    const app = await this.ensureMarketApp('agent', name);
    const title = (body?.name ?? '').trim();
    const description = body?.description ?? '';
    await upsertApp(this.db, {
      kind: 'agent',
      appId: name,
      title: title || app.title,
      description: description || app.description,
      owner: app.owner,
      channel: CHANNEL_MARKET,
      enabled: app.enabled,
    });
    await this.audit.log(username, 'agent_update_meta', name);
  }

  /** 管理面：下架市场智能体。 */
  async disableAgent(name: string, username: string): Promise<void> {
    await this.setAgentEnabled(name, false);
    await this.audit.log(username, 'agent_disable', name);
  }

  /** 管理面：重新上架市场智能体。 */
  async enableAgent(name: string, username: string): Promise<void> {
    await this.setAgentEnabled(name, true);
    await this.audit.log(username, 'agent_enable', name);
  }

  private async setAgentEnabled(name: string, enabled: boolean): Promise<void> {
    await this.ensureMarketApp('agent', name);
    const ok = await setAppEnabled(this.db, 'agent', name, enabled);
    if (!ok) throw new ApiError('NOT_FOUND', '智能体不存在');
  }

  /** 管理面：上传市场智能体归档（管理员上传即已审核）。 */
  async uploadAgentArchive(
    name: string,
    body: { version?: string; archive?: unknown },
    username: string,
  ): Promise<{ version: string; checksum: string }> {
    const version = (body?.version ?? '').trim();
    const archive = body?.archive;
    if (!version || archive == null) {
      throw new ApiError('VALIDATION', 'version 与 archive 必填', 400);
    }
    if (!isAppId(name)) throw new ApiError('VALIDATION', '智能体名不合法', 400);
    if (version.includes('/') || version.includes('\\') || !isVersion(version)) {
      throw new ApiError('VALIDATION', '版本不合法', 400);
    }
    const { buf, checksum } = this.decodeArchive(archive);
    const app = await this.ensureMarketApp('agent', name);
    await this.publishRelease('agent', app, version, buf, checksum, username);
    await this.audit.log(username, 'agent_update', `${name}@${version}`);
    return { version, checksum };
  }

  /** 管理面：市场智能体预览。 */
  async previewAgent(name: string): Promise<{
    files: unknown[];
    composition: string;
    version: string;
  }> {
    await this.ensureMarketApp('agent', name);
    const shown = await this.shownRelease('agent', name);
    if (!shown) throw new ApiError('NOT_FOUND', '智能体尚未发布版本');
    return { files: [], composition: '', version: shown.version };
  }

  /** 管理面：市场智能体文件读取（无归档解析器 → 空内容结构）。 */
  async agentFile(
    name: string,
    path: string,
  ): Promise<{ size: number; content?: string; binary?: boolean; too_large?: boolean }> {
    await this.ensureMarketApp('agent', name);
    const shown = await this.shownRelease('agent', name);
    if (!shown) throw new ApiError('NOT_FOUND', '智能体尚未发布版本');
    // path 仅用于形状对齐；真正的归档解析在 agentshare 域（本服务不落盘）。
    return { size: 0, content: '' };
  }

  /** 管理面：下载市场智能体当前展示版本归档。 */
  async downloadAgentArchive(name: string): Promise<ArchivePayload> {
    await this.ensureMarketApp('agent', name);
    const shown = await this.shownRelease('agent', name);
    if (!shown) throw new ApiError('NOT_FOUND', '智能体尚未发布版本');
    const release = await getRelease(this.db, 'agent', name, shown.version);
    if (!release?.archive || release.archive.length === 0) {
      throw new ApiError('NOT_FOUND', '智能体尚未发布版本');
    }
    const { contentType, ext } = this.archiveKind(release.archive);
    await incrementReleaseDownload(this.db, 'agent', name, shown.version);
    return {
      archive: release.archive,
      version: shown.version,
      checksum:
        release.checksum ||
        this.crypto.sha256(release.archive.toString('binary')),
      filename: `${name}-${shown.version}${ext}`,
      contentType,
    };
  }

  // ------------------------------------------------------------ agent grants

  async listAgentGrants(name: string): Promise<GrantJSON[]> {
    await this.ensureMarketApp('agent', name);
    return listAppGrants(this.db, 'agent', name);
  }

  async replaceAgentGrants(
    name: string,
    rawGroups: unknown,
    username: string,
  ): Promise<void> {
    await this.replaceGroups('agent', name, rawGroups, username);
  }

  async grantAgent(
    name: string,
    body: { username?: string; group?: string },
    username: string,
  ): Promise<void> {
    await this.applyGrant('agent', name, body, username, true);
  }

  async revokeAgentGrant(
    name: string,
    body: { username?: string; group?: string },
    username: string,
  ): Promise<void> {
    await this.applyGrant('agent', name, body, username, false);
  }
}
