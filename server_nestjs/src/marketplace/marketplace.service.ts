import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import {
  agentPresetGrants,
  agentPresets,
  groups,
  sharedSkills,
  skillGrants,
  skills,
  type AgentPreset,
  type Skill,
} from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { rfc3339UTC } from '../common/time';
import {
  granteeMatch,
  isAppId,
  isVersion,
  normalizeGrantee,
  resolveUserGroupNames,
} from '../common/skills-shared';

/** 商城技能 JSON（snake_case，与 Go skillJSON 逐字段对齐；无 downloads/calls/official 列 → 默认）。 */
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

/** 商城智能体 JSON（市场通道，无 enabled/official 列 → 默认）。 */
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

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_REASON_LEN = 500;

@Injectable()
export class MarketplaceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  // ------------------------------------------------------------------ helpers

  private toSkillJSON(s: Skill): SkillJSON {
    return {
      id: s.id,
      name: s.name,
      version: s.version,
      description: s.description,
      author: s.author,
      checksum: s.checksum,
      enabled: s.enabled === 1,
      downloads: 0,
      calls: 0,
      official: false,
      created_at: rfc3339UTC(s.createdAt),
      updated_at: rfc3339UTC(s.updatedAt),
    };
  }

  private toAgentJSON(p: AgentPreset): AgentJSON {
    return {
      name: p.name,
      title: p.displayName,
      description: p.description,
      author: p.author,
      enabled: true,
      official: false,
      created_at: rfc3339UTC(p.createdAt),
      updated_at: rfc3339UTC(p.updatedAt),
      version: p.version,
      quality: '',
      downloads: 0,
      changelog: '',
    };
  }

  /** 员工面当前用户是否视为「管理全量」（super_admin / auditor）。 */
  private adminFull(role: string): boolean {
    return role === 'super_admin' || role === 'auditor';
  }

  /** 解码 + 校验归档 base64，返回 sha256 校验和。 */
  private decodeArchive(archive: unknown): string {
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
    return this.crypto.sha256(buf.toString('binary'));
  }

  // ------------------------------------------------------------ skills (market)

  /** 管理面：全量商城技能（含下架）。 */
  async listSkills(): Promise<SkillJSON[]> {
    const rows = await this.db.select().from(skills).orderBy(skills.name);
    return rows.map((s) => this.toSkillJSON(s));
  }

  /** 员工面：enabled + 授权（admin 全量）。 */
  async listMarketSkillsForEmployee(
    username: string,
    role: string,
    userId: number,
  ): Promise<SkillJSON[]> {
    const rows = await this.db
      .select()
      .from(skills)
      .where(eq(skills.enabled, 1))
      .orderBy(skills.name);
    if (this.adminFull(role)) return rows.map((s) => this.toSkillJSON(s));

    const groups = await resolveUserGroupNames(this.db, userId);
    const granted = await this.db
      .selectDistinct({ name: skillGrants.skillName })
      .from(skillGrants)
      .where(granteeMatch(username, groups));
    const grantedSet = new Set(granted.map((g) => g.name));
    return rows
      .filter((s) => grantedSet.has(s.name))
      .map((s) => this.toSkillJSON(s));
  }

  /** 员工面：单个技能，授权先于下架判定（未授权 404 不泄露存在性）。 */
  async getMarketSkill(
    name: string,
    username: string,
    role: string,
    userId: number,
  ): Promise<SkillJSON> {
    const [s] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (!s) throw new ApiError('NOT_FOUND', '技能不存在');

    if (!this.adminFull(role)) {
      const groups = await resolveUserGroupNames(this.db, userId);
      const [g] = await this.db
        .select()
        .from(skillGrants)
        .where(
          and(
            eq(skillGrants.skillName, name),
            granteeMatch(username, groups),
          ),
        )
        .limit(1);
      if (!g) throw new ApiError('NOT_FOUND', '技能不存在');
    }
    if (s.enabled !== 1) throw new ApiError('NOT_FOUND', '技能已下架');
    return this.toSkillJSON(s);
  }

  /** 管理面：创建商城技能。 */
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
        '技能名不合法:必须是小写 kebab-case',
      );
    }
    // 同名共享技能冲突（跨通道）。
    const [org] = await this.db
      .select({ name: sharedSkills.name })
      .from(sharedSkills)
      .where(eq(sharedSkills.name, name))
      .limit(1);
    if (org) throw new ApiError('CONFLICT', '名称与共享技能冲突');
    const [dup] = await this.db
      .select({ name: skills.name })
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (dup) throw new ApiError('VALIDATION', '技能已存在', 400);

    const version = (body?.version ?? '').trim() || '1.0.0';
    const description = body?.description ?? '';
    const author = body?.author ?? '';
    const [row] = await this.db
      .insert(skills)
      .values({ name, version, description, author, gitUrl: '' })
      .returning();
    await this.audit.log(author || 'admin', 'skill_create', name);
    return this.toSkillJSON(row);
  }

  /** 管理面：更新技能元信息（不动 owner/author）。 */
  async updateSkillMeta(
    name: string,
    body: { name?: string; version?: string; description?: string; author?: string },
  ): Promise<SkillJSON> {
    const [row] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');

    if (body?.version != null && body.version !== row.version) {
      throw new ApiError(
        'VALIDATION',
        '请用「上传新版」随归档一起更改版本',
        400,
      );
    }
    if (body?.author != null && body.author !== row.author) {
      throw new ApiError(
        'VALIDATION',
        '归属(负责人)不能在这里修改，请使用专门的负责人变更流程',
        400,
      );
    }
    const description = body?.description;
    if (description !== undefined && description !== '') {
      await this.db
        .update(skills)
        .set({ description, updatedAt: new Date() })
        .where(eq(skills.name, name));
    }
    await this.audit.log('admin', 'skill_update', name);
    const [fresh] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    return this.toSkillJSON(fresh);
  }

  /** 管理面：软下架。 */
  async disableSkill(name: string, username: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    await this.db
      .update(skills)
      .set({ enabled: 0, updatedAt: new Date() })
      .where(eq(skills.name, name));
    await this.audit.log(username, 'skill_disable', name);
  }

  /** 管理面：上架。 */
  async enableSkill(name: string, username: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    await this.db
      .update(skills)
      .set({ enabled: 1, updatedAt: new Date() })
      .where(eq(skills.name, name));
    await this.audit.log(username, 'skill_enable', name);
  }

  /** 管理面：上传新版归档。 */
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
    if (version.includes('/') || version.includes('\\')) {
      throw new ApiError('VALIDATION', '版本不合法', 400);
    }
    if (!isVersion(version)) {
      throw new ApiError('VALIDATION', '版本不合法', 400);
    }
    const checksum = this.decodeArchive(archive);
    const [row] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    await this.db
      .update(skills)
      .set({ version, checksum, updatedAt: new Date() })
      .where(eq(skills.name, name));
    await this.audit.log(username, 'skill_update', `${name}@${version}`);
    return { version, checksum };
  }

  /** 管理面：技能预览（无归档字节 → 空文件清单结构）。 */
  async previewSkill(name: string): Promise<{
    files: unknown[];
    skill_md: string;
    name: string;
    version: string;
    checksum: string;
  }> {
    const [row] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    return {
      files: [],
      skill_md: '',
      name: row.name,
      version: row.version,
      checksum: row.checksum,
    };
  }

  /** 管理面：技能归档内文件读取（无归档字节 → 结构）。 */
  async skillFile(
    name: string,
    path: string,
  ): Promise<{ path: string; size: number; binary: boolean; too_large: boolean; content: string }> {
    const [row] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    const p = (path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    return { path: p, size: 0, binary: false, too_large: false, content: '' };
  }

  /** 员工/管理面：归档下载（重写版不落盘归档字节，返回 404 结构）。 */
  async downloadSkillArchive(name: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    throw new ApiError('NOT_FOUND', '归档文件未存储');
  }

  /** 管理面：规范化（无文件内容 → 已合规结构）。 */
  async normalizeSkill(name: string): Promise<{
    version: string;
    checksum: string;
    changes: unknown[];
    already_compliant: boolean;
  }> {
    const [row] = await this.db
      .select()
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    return {
      version: row.version,
      checksum: row.checksum,
      changes: [],
      already_compliant: true,
    };
  }

  // ------------------------------------------------------------ skills grants

  async listSkillGrants(name: string): Promise<GrantJSON[]> {
    const rows = await this.db
      .select()
      .from(skillGrants)
      .where(eq(skillGrants.skillName, name))
      .orderBy(skillGrants.granteeType, skillGrants.grantee);
    return rows.map((g) => ({ grantee_type: g.granteeType, grantee: g.grantee }));
  }

  async replaceSkillGrants(
    name: string,
    rawGroups: unknown,
    username: string,
  ): Promise<void> {
    const list = Array.isArray(rawGroups) ? rawGroups.map(String) : [];
    const cleaned: string[] = [];
    for (const g of list) {
      const n = normalizeGrantee(g);
      if (!n) throw new ApiError('VALIDATION', '部门名不合法或不存在', 400);
      if (!cleaned.includes(n)) cleaned.push(n);
    }
    // 校验每个部门存在（大小写不敏感）。
    for (const g of cleaned) {
      const [exists] = await this.db
        .select({ id: groups.id })
        .from(groups)
        .where(sql`lower(${groups.name}) = ${g.toLowerCase()}`)
        .limit(1);
      if (!exists) throw new ApiError('VALIDATION', '部门名不合法或不存在', 400);
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(skillGrants).where(and(eq(skillGrants.skillName, name), eq(skillGrants.granteeType, 'group')));
      for (const g of cleaned) {
        await tx.insert(skillGrants).values({ skillName: name, granteeType: 'group', grantee: g }).onConflictDoNothing();
      }
    });
    await this.audit.log(username, 'skill_grants_replace', name);
  }

  async grantSkill(
    name: string,
    body: { username?: string; group?: string },
    username: string,
  ): Promise<void> {
    const hasUser = body?.username != null && body.username !== '';
    const raw = hasUser ? body!.username! : (body?.group ?? '');
    const grantee = normalizeGrantee(raw);
    if (!grantee) throw new ApiError('VALIDATION', '授权对象不合法', 400);
    const granteeType = hasUser ? ('user' as const) : ('group' as const);
    if (granteeType === 'group') {
      const [exists] = await this.db
        .select({ id: groups.id })
        .from(groups)
        .where(sql`lower(${groups.name}) = ${grantee.toLowerCase()}`)
        .limit(1);
      if (!exists) throw new ApiError('VALIDATION', '部门名不合法或不存在', 400);
    }
    await this.db
      .insert(skillGrants)
      .values({ skillName: name, granteeType, grantee })
      .onConflictDoNothing();
    await this.audit.log(username, 'skill_grant', `${name}:${granteeType}:${grantee}`);
  }

  async revokeSkillGrant(
    name: string,
    body: { username?: string; group?: string },
    username: string,
  ): Promise<void> {
    const hasUser = body?.username != null && body.username !== '';
    const raw = hasUser ? body!.username! : (body?.group ?? '');
    const grantee = normalizeGrantee(raw);
    if (!grantee) throw new ApiError('VALIDATION', '授权对象不合法', 400);
    const granteeType = hasUser ? ('user' as const) : ('group' as const);
    await this.db
      .delete(skillGrants)
      .where(
        and(
          eq(skillGrants.skillName, name),
          eq(skillGrants.granteeType, granteeType),
          eq(skillGrants.grantee, grantee),
        ),
      );
    await this.audit.log(username, 'skill_revoke', `${name}:${granteeType}:${grantee}`);
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

  /** 管理面：全量市场智能体。 */
  async listAgents(): Promise<AgentJSON[]> {
    const rows = await this.db
      .select()
      .from(agentPresets)
      .where(eq(agentPresets.status, 'approved'))
      .orderBy(agentPresets.name, agentPresets.version);
    return rows.map((p) => this.toAgentJSON(p));
  }

  /** 管理面：创建市场智能体（市场通道无审核 → status=approved）。 */
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
      );
    }
    // 跨通道冲突（共享 Agent 预设）。
    const [org] = await this.db
      .select({ name: agentPresets.name })
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), sql`${agentPresets.status} <> 'approved'`))
      .limit(1);
    if (org) throw new ApiError('CONFLICT', '名称与共享智能体冲突');
    const [dup] = await this.db
      .select({ name: agentPresets.name })
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.status, 'approved')))
      .limit(1);
    if (dup) throw new ApiError('VALIDATION', '智能体已存在', 400);

    const author = (body?.author ?? '').trim() || adminUsername;
    const description = body?.description ?? '';
    const [row] = await this.db
      .insert(agentPresets)
      .values({
        name,
        displayName: name,
        version: '1.0.0',
        description,
        author,
        checksum: '',
        status: 'approved',
        reason: '',
      })
      .returning();
    await this.audit.log(adminUsername, 'agent_create', name);
    return this.toAgentJSON(row);
  }

  /** 管理面：更新市场智能体元信息（不动 owner）。 */
  async updateAgentMeta(
    name: string,
    body: { name?: string; description?: string; author?: string },
    username: string,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.status, 'approved')))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '智能体不存在');
    const title = (body?.name ?? '').trim();
    const description = body?.description ?? '';
    await this.db
      .update(agentPresets)
      .set({
        ...(title ? { displayName: title } : {}),
        ...(description ? { description } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agentPresets.id, row.id));
    await this.audit.log(username, 'agent_update_meta', name);
  }

  /** 管理面：软下架市场智能体（无 enabled 列 → 校验存在 + 审计的 no-op）。 */
  async disableAgent(name: string, username: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.status, 'approved')))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '智能体不存在');
    await this.audit.log(username, 'agent_disable', name);
  }

  /** 管理面：上架市场智能体（no-op）。 */
  async enableAgent(name: string, username: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.status, 'approved')))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '智能体不存在');
    await this.audit.log(username, 'agent_enable', name);
  }

  /** 管理面：上传市场智能体归档（更新版本 + 校验和）。 */
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
    if (!isVersion(version)) {
      throw new ApiError('VALIDATION', '版本不合法', 400);
    }
    const checksum = this.decodeArchive(archive);
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.status, 'approved')))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '智能体不存在');
    await this.db
      .update(agentPresets)
      .set({ version, checksum, updatedAt: new Date() })
      .where(eq(agentPresets.id, row.id));
    await this.audit.log(username, 'agent_update', `${name}@${version}`);
    return { version, checksum };
  }

  /** 管理面：市场智能体预览（无归档字节 → 结构）。 */
  async previewAgent(name: string): Promise<{
    files: unknown[];
    composition: string;
    version: string;
  }> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.status, 'approved')))
      .orderBy(desc(agentPresets.createdAt))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '智能体尚未发布版本');
    return { files: [], composition: '', version: row.version };
  }

  /** 管理面：市场智能体文件读取（结构）。 */
  async agentFile(
    name: string,
    path: string,
  ): Promise<{ size: number; content?: string; binary?: boolean; too_large?: boolean }> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.status, 'approved')))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '智能体不存在');
    return { size: 0, content: '' };
  }

  /** 员工/管理面：市场智能体归档下载（no-op 404）。 */
  async downloadAgentArchive(name: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.status, 'approved')))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '智能体不存在');
    throw new ApiError('NOT_FOUND', '归档文件未存储');
  }

  // ------------------------------------------------------------ agent grants

  async listAgentGrants(name: string): Promise<GrantJSON[]> {
    const rows = await this.db
      .select()
      .from(agentPresetGrants)
      .where(eq(agentPresetGrants.presetName, name))
      .orderBy(agentPresetGrants.granteeType, agentPresetGrants.grantee);
    return rows.map((g) => ({ grantee_type: g.granteeType, grantee: g.grantee }));
  }

  async replaceAgentGrants(
    name: string,
    rawGroups: unknown,
    username: string,
  ): Promise<void> {
    const list = Array.isArray(rawGroups) ? rawGroups.map(String) : [];
    const cleaned: string[] = [];
    for (const g of list) {
      const n = normalizeGrantee(g);
      if (!n) throw new ApiError('VALIDATION', '部门名不合法或不存在', 400);
      if (!cleaned.includes(n)) cleaned.push(n);
    }
    for (const g of cleaned) {
      const [exists] = await this.db
        .select({ id: groups.id })
        .from(groups)
        .where(sql`lower(${groups.name}) = ${g.toLowerCase()}`)
        .limit(1);
      if (!exists) throw new ApiError('VALIDATION', '部门名不合法或不存在', 400);
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(agentPresetGrants).where(and(eq(agentPresetGrants.presetName, name), eq(agentPresetGrants.granteeType, 'group')));
      for (const g of cleaned) {
        await tx.insert(agentPresetGrants).values({ presetName: name, granteeType: 'group', grantee: g }).onConflictDoNothing();
      }
    });
    await this.audit.log(username, 'agent_grants', name);
  }

  async grantAgent(
    name: string,
    body: { username?: string; group?: string },
    username: string,
  ): Promise<void> {
    const hasUser = body?.username != null && body.username !== '';
    const raw = hasUser ? body!.username! : (body?.group ?? '');
    const grantee = normalizeGrantee(raw);
    if (!grantee) throw new ApiError('VALIDATION', '授权对象不合法', 400);
    const granteeType = hasUser ? ('user' as const) : ('group' as const);
    if (granteeType === 'group') {
      const [exists] = await this.db
        .select({ id: groups.id })
        .from(groups)
        .where(sql`lower(${groups.name}) = ${grantee.toLowerCase()}`)
        .limit(1);
      if (!exists) throw new ApiError('VALIDATION', '部门名不合法或不存在', 400);
    }
    await this.db
      .insert(agentPresetGrants)
      .values({ presetName: name, granteeType, grantee })
      .onConflictDoNothing();
    await this.audit.log(username, 'agent_grant', `${name}:${granteeType}:${grantee}`);
  }

  async revokeAgentGrant(
    name: string,
    body: { username?: string; group?: string },
    username: string,
  ): Promise<void> {
    const hasUser = body?.username != null && body.username !== '';
    const raw = hasUser ? body!.username! : (body?.group ?? '');
    const grantee = normalizeGrantee(raw);
    if (!grantee) throw new ApiError('VALIDATION', '授权对象不合法', 400);
    const granteeType = hasUser ? ('user' as const) : ('group' as const);
    await this.db
      .delete(agentPresetGrants)
      .where(
        and(
          eq(agentPresetGrants.presetName, name),
          eq(agentPresetGrants.granteeType, granteeType),
          eq(agentPresetGrants.grantee, grantee),
        ),
      );
    await this.audit.log(username, 'agent_revoke', `${name}:${granteeType}:${grantee}`);
  }
}
