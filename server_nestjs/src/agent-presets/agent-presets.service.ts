import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import {
  agentPresetGrants,
  agentPresets,
  groups,
  type AgentPreset,
} from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { rfc3339UTC } from '../common/time';
import {
  granteeMatch,
  isAppId,
  normalizeGrantee,
  resolveUserGroupNames,
} from '../common/skills-shared';

/** 共享 Agent 预设 JSON（snake_case；无 quality/downloads 列 → 默认）。 */
export interface PresetJSON {
  name: string;
  display_name: string;
  description: string;
  version: string;
  author: string;
  status: 'pending' | 'approved' | 'rejected';
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

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_REASON_LEN = 500;

@Injectable()
export class AgentPresetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  private toJSON(p: AgentPreset): PresetJSON {
    return {
      name: p.name,
      display_name: p.displayName,
      description: p.description,
      version: p.version,
      author: p.author,
      status: p.status,
      reason: p.reason,
      quality: '',
      downloads: 0,
      created_at: rfc3339UTC(p.createdAt),
      updated_at: rfc3339UTC(p.updatedAt),
    };
  }

  private adminFull(role: string): boolean {
    return role === 'super_admin' || role === 'auditor';
  }

  private decodeArchive(archive: unknown): string {
    if (typeof archive !== 'string' || archive.length === 0) {
      throw new ApiError('VALIDATION', '归档编码错误或为空', 400);
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(archive, 'base64');
      if (
        buf.toString('base64').replace(/=+$/, '') !==
        archive.replace(/=+$/, '')
      ) {
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

  /** 展示版本：最高 approved；否则最新 created；否则 null。 */
  private async displayVersion(name: string): Promise<AgentPreset | undefined> {
    const [approved] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.status, 'approved')))
      .orderBy(desc(agentPresets.createdAt))
      .limit(1);
    if (approved) return approved;
    const [latest] = await this.db
      .select()
      .from(agentPresets)
      .where(eq(agentPresets.name, name))
      .orderBy(desc(agentPresets.createdAt))
      .limit(1);
    return latest;
  }

  // ------------------------------------------------------------ employee

  /** 员工面分发：approved ∧ (owner 或 已授权)；admin 全量 approved。 */
  async listVisibleForEmployee(
    username: string,
    role: string,
    userId: number,
  ): Promise<PresetJSON[]> {
    const rows = await this.db
      .select()
      .from(agentPresets)
      .orderBy(agentPresets.name, agentPresets.version);

    if (this.adminFull(role)) {
      return rows.filter((r) => r.status === 'approved').map((r) => this.toJSON(r));
    }

    const groups = await resolveUserGroupNames(this.db, userId);
    const grantedRows = await this.db
      .selectDistinct({ name: agentPresetGrants.presetName })
      .from(agentPresetGrants)
      .where(granteeMatch(username, groups));
    const grantedSet = new Set(grantedRows.map((g) => g.name));

    return rows
      .filter(
        (r) =>
          r.author === username ||
          (r.status === 'approved' && grantedSet.has(r.name)),
      )
      .map((r) => this.toJSON(r));
  }

  /** 员工面「我的」分区（capabilities source=own 复用）。 */
  async listOwned(username: string): Promise<PresetJSON[]> {
    const rows = await this.db
      .select()
      .from(agentPresets)
      .where(eq(agentPresets.author, username))
      .orderBy(agentPresets.name, agentPresets.version);
    return rows.map((r) => this.toJSON(r));
  }

  /** 员工面：上传共享 Agent 预设 → pending。 */
  async upload(
    body: {
      name?: string;
      display_name?: string;
      version?: string;
      description?: string;
      archive?: unknown;
    },
    username: string,
  ): Promise<{ name: string; version: string; status: 'pending' }> {
    const name = (body?.name ?? '').trim();
    if (!name) throw new ApiError('VALIDATION', '名称必填', 400);
    if (!isAppId(name)) {
      throw new ApiError('INVALID_APP_ID', '预设名不合法:必须是小写 kebab-case');
    }
    // 市场同名（status=approved 视为市场智能体）→ 跨通道冲突。
    const [market] = await this.db
      .select({ name: agentPresets.name })
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.status, 'approved')))
      .limit(1);
    if (market) throw new ApiError('CONFLICT', '名称与市场智能体冲突');

    const version = (body?.version ?? '').trim() || '1.0.0';
    const displayName = body?.display_name ?? '';
    const description = body?.description ?? '';
    const checksum = this.decodeArchive(body?.archive);

    const [existing] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.version, version)))
      .limit(1);
    if (existing) {
      if (existing.status === 'rejected') {
        await this.db
          .update(agentPresets)
          .set({
            displayName,
            description,
            checksum,
            status: 'pending',
            reason: '',
            updatedAt: new Date(),
          })
          .where(eq(agentPresets.id, existing.id));
        return { name, version, status: 'pending' };
      }
      throw new ApiError('VALIDATION', '该版本已存在', 400);
    }

    await this.db.insert(agentPresets).values({
      name,
      displayName,
      version,
      description,
      author: username,
      checksum,
      status: 'pending',
      reason: '',
    });
    await this.audit.log(username, 'agent_preset_upload', `${name}@${version}`);
    return { name, version, status: 'pending' };
  }

  /** 员工面：归档下载（双通道；owner / approved+授权；未授权 404）。 */
  async downloadForEmployee(
    name: string,
    version: string | undefined,
    username: string,
    role: string,
    userId: number,
  ): Promise<void> {
    let row: AgentPreset | undefined;
    if (version) {
      const [r] = await this.db
        .select()
        .from(agentPresets)
        .where(and(eq(agentPresets.name, name), eq(agentPresets.version, version)))
        .limit(1);
      row = r;
    } else {
      row = await this.displayVersion(name);
    }
    if (!row) throw new ApiError('NOT_FOUND', '预设不存在');

    if (!this.adminFull(role)) {
      if (row.author !== username) {
        if (row.status !== 'approved') {
          throw new ApiError('NOT_FOUND', '预设不存在');
        }
        const groups = await resolveUserGroupNames(this.db, userId);
        const [g] = await this.db
          .select()
          .from(agentPresetGrants)
          .where(
            and(
              eq(agentPresetGrants.presetName, name),
              granteeMatch(username, groups),
            ),
          )
          .limit(1);
        if (!g) throw new ApiError('NOT_FOUND', '预设不存在');
      }
    }
    throw new ApiError('NOT_FOUND', '归档文件未存储');
  }

  // ------------------------------------------------------------ admin

  async listAll(status?: string): Promise<PresetJSON[]> {
    const rows = await this.db
      .select()
      .from(agentPresets)
      .where(
        status ? eq(agentPresets.status, status as AgentPreset['status']) : undefined,
      )
      .orderBy(agentPresets.name, agentPresets.version);
    return rows.map((r) => this.toJSON(r));
  }

  async download(name: string, version?: string): Promise<void> {
    const row = version
      ? (
          await this.db
            .select()
            .from(agentPresets)
            .where(and(eq(agentPresets.name, name), eq(agentPresets.version, version)))
            .limit(1)
        )[0]
      : await this.displayVersion(name);
    if (!row) throw new ApiError('NOT_FOUND', '预设不存在');
    throw new ApiError('NOT_FOUND', '归档文件未存储');
  }

  async preview(name: string): Promise<{
    files: unknown[];
    composition: string;
  }> {
    const row = await this.displayVersion(name);
    if (!row) throw new ApiError('NOT_FOUND', '预设不存在');
    return { files: [], composition: '' };
  }

  async previewVersion(name: string, version: string): Promise<{
    files: unknown[];
    composition: string;
  }> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '预设不存在');
    return { files: [], composition: '' };
  }

  /** 审核目标：最高非 approved 版本；无则回落展示版本（最高 approved）。 */
  private async reviewTarget(name: string): Promise<AgentPreset> {
    const [nonApproved] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), ne(agentPresets.status, 'approved')))
      .orderBy(desc(agentPresets.createdAt))
      .limit(1);
    if (nonApproved) return nonApproved;
    const display = await this.displayVersion(name);
    if (!display) throw new ApiError('NOT_FOUND', '预设不存在');
    return display;
  }

  async approve(name: string, username: string): Promise<void> {
    const row = await this.reviewTarget(name);
    await this.approveVersion(name, row.version, username);
  }

  async approveVersion(
    name: string,
    version: string,
    username: string,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '预设不存在');
    if (row.status === 'rejected') {
      throw new ApiError(
        'ARCHIVE_CLEARED',
        '该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本',
      );
    }
    await this.db
      .update(agentPresets)
      .set({ status: 'approved', reason: '', updatedAt: new Date() })
      .where(eq(agentPresets.id, row.id));
    await this.audit.log(username, 'agent_preset_approve', `${name}@${version}`);
  }

  async reject(
    name: string,
    reason: string,
    username: string,
  ): Promise<void> {
    const row = await this.reviewTarget(name);
    await this.rejectVersion(name, row.version, reason, username);
  }

  async rejectVersion(
    name: string,
    version: string,
    reason: string,
    username: string,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '预设不存在');
    if (!reason || reason.trim() === '') {
      throw new ApiError('VALIDATION', '请填写拒绝理由', 400);
    }
    if (reason.length > MAX_REASON_LEN) {
      throw new ApiError('VALIDATION', '拒绝理由过长(上限 500 字)', 400);
    }
    if (row.status === 'approved') {
      throw new ApiError('APPROVED_NOT_REJECTABLE', '已审核通过的版本不可驳回');
    }
    await this.db
      .update(agentPresets)
      .set({ status: 'rejected', reason, checksum: '', updatedAt: new Date() })
      .where(eq(agentPresets.id, row.id));
    await this.audit.log(username, 'agent_preset_reject', `${name}@${version}`);
  }

  /** 删除某 name 的全部版本 + 清授权。 */
  async deleteAll(name: string, username: string): Promise<void> {
    const rows = await this.db
      .select()
      .from(agentPresets)
      .where(eq(agentPresets.name, name));
    if (rows.length === 0) throw new ApiError('NOT_FOUND', '预设不存在');
    await this.db.delete(agentPresets).where(eq(agentPresets.name, name));
    await this.db.delete(agentPresetGrants).where(eq(agentPresetGrants.presetName, name));
    await this.audit.log(username, 'agent_preset_delete', name);
  }

  async deleteVersion(
    name: string,
    version: string,
    username: string,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '预设不存在');
    await this.db.delete(agentPresets).where(eq(agentPresets.id, row.id));
    const remaining = await this.db
      .select({ id: agentPresets.id })
      .from(agentPresets)
      .where(eq(agentPresets.name, name))
      .limit(1);
    if (remaining.length === 0) {
      await this.db.delete(agentPresetGrants).where(eq(agentPresetGrants.presetName, name));
    }
    await this.audit.log(username, 'agent_preset_delete', `${name}@${version}`);
  }

  async setQuality(
    name: string,
    version: string,
    quality: string,
    username: string,
  ): Promise<{ quality: string }> {
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(and(eq(agentPresets.name, name), eq(agentPresets.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '预设不存在');
    if (quality !== '' && quality !== 'featured') {
      throw new ApiError('VALIDATION', '质量标记不合法(空/featured)', 400);
    }
    if (row.status !== 'approved') {
      throw new ApiError('VALIDATION', '仅审核通过的版本可设置质量标记', 400);
    }
    await this.audit.log(username, 'agent_preset_qualify', `${name}@${version}`);
    return { quality };
  }

  async file(
    name: string,
    version: string | undefined,
    path: string,
  ): Promise<{ path: string; size: number; binary: boolean; too_large: boolean; content: string }> {
    const row = version
      ? (
          await this.db
            .select()
            .from(agentPresets)
            .where(and(eq(agentPresets.name, name), eq(agentPresets.version, version)))
            .limit(1)
        )[0]
      : await this.displayVersion(name);
    if (!row) throw new ApiError('NOT_FOUND', '预设不存在');
    const p = (path ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    return { path: p, size: 0, binary: false, too_large: false, content: '' };
  }

  async setEnabled(
    name: string,
    body: { enabled?: boolean },
    username: string,
  ): Promise<{ enabled: boolean }> {
    if (
      body == null ||
      typeof body !== 'object' ||
      typeof body.enabled !== 'boolean'
    ) {
      throw new ApiError(
        'VALIDATION',
        '请求体格式错误(需要 {"enabled": true|false})',
        400,
      );
    }
    const [row] = await this.db
      .select()
      .from(agentPresets)
      .where(eq(agentPresets.name, name))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '预设不存在');
    await this.audit.log(
      username,
      body.enabled ? 'agent_preset_enable' : 'agent_preset_disable',
      name,
    );
    return { enabled: body.enabled };
  }

  // ------------------------------------------------------------ grants

  async listGrants(name: string): Promise<PresetGrantJSON[]> {
    const rows = await this.db
      .select()
      .from(agentPresetGrants)
      .where(eq(agentPresetGrants.presetName, name))
      .orderBy(agentPresetGrants.granteeType, agentPresetGrants.grantee);
    return rows.map((g) => ({ grantee_type: g.granteeType, grantee: g.grantee }));
  }

  async replaceGrants(
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
      await tx
        .delete(agentPresetGrants)
        .where(
          and(
            eq(agentPresetGrants.presetName, name),
            eq(agentPresetGrants.granteeType, 'group'),
          ),
        );
      for (const g of cleaned) {
        await tx
          .insert(agentPresetGrants)
          .values({ presetName: name, granteeType: 'group', grantee: g })
          .onConflictDoNothing();
      }
    });
    await this.audit.log(username, 'agent_preset_grant', name);
  }

  async grant(
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
    await this.audit.log(username, 'agent_preset_grant', `${name}:${granteeType}:${grantee}`);
  }

  async revoke(
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
    await this.audit.log(username, 'agent_preset_revoke', `${name}:${granteeType}:${grantee}`);
  }
}
