import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import {
  groups,
  sharedSkillGrants,
  sharedSkills,
  skills,
  type SharedSkill,
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

/** 共享技能行 JSON（snake_case；无 quality/downloads/calls 列 → 默认）。 */
export interface SharedSkillJSON {
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: string;
  status: 'pending' | 'approved' | 'rejected';
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

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_REASON_LEN = 500;

@Injectable()
export class SharedSkillsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  private toJSON(s: SharedSkill): SharedSkillJSON {
    return {
      name: s.name,
      display_name: s.displayName,
      version: s.version,
      description: s.description,
      author: s.author,
      status: s.status,
      reason: s.reason,
      quality: '',
      downloads: 0,
      calls: 0,
      created_at: rfc3339UTC(s.createdAt),
      updated_at: rfc3339UTC(s.updatedAt),
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

  // ------------------------------------------------------------ employee

  /** 员工面分发：approved ∧ (owner 或 已授权)；admin 全量 approved。 */
  async listVisibleForEmployee(
    username: string,
    role: string,
    userId: number,
  ): Promise<Array<SharedSkillJSON & { enabled: boolean }>> {
    const rows = await this.db
      .select()
      .from(sharedSkills)
      .orderBy(sharedSkills.name, sharedSkills.version);

    if (this.adminFull(role)) {
      return rows
        .filter((r) => r.status === 'approved')
        .map((r) => ({ ...this.toJSON(r), enabled: true }));
    }

    const groups = await resolveUserGroupNames(this.db, userId);
    const grantedRows = await this.db
      .selectDistinct({ name: sharedSkillGrants.skillName })
      .from(sharedSkillGrants)
      .where(granteeMatch(username, groups));
    const grantedSet = new Set(grantedRows.map((g) => g.name));

    return rows
      .filter(
        (r) =>
          r.author === username ||
          (r.status === 'approved' && grantedSet.has(r.name)),
      )
      .map((r) => ({ ...this.toJSON(r), enabled: true }));
  }

  /** 员工面「我的」分区（供 capabilities source=own 复用）：owner 的任意状态行。 */
  async listOwned(username: string): Promise<SharedSkillJSON[]> {
    const rows = await this.db
      .select()
      .from(sharedSkills)
      .where(eq(sharedSkills.author, username))
      .orderBy(sharedSkills.name, sharedSkills.version);
    return rows.map((r) => this.toJSON(r));
  }

  /** 员工面：上传共享技能 → pending。 */
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
      throw new ApiError('INVALID_APP_ID', '技能名不合法:必须是小写 kebab-case');
    }
    // 跨通道互斥：市场技能同名 → 冲突。
    const [market] = await this.db
      .select({ name: skills.name })
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (market) throw new ApiError('CONFLICT', '名称与市场技能冲突');

    // 版本以包为准（重写版无包解析 → 用 body 版本或默认 1.0.0）。
    const version = (body?.version ?? '').trim() || '1.0.0';
    const displayName = body?.display_name ?? '';
    const description = body?.description ?? '';
    const checksum = this.decodeArchive(body?.archive);

    const [existing] = await this.db
      .select()
      .from(sharedSkills)
      .where(and(eq(sharedSkills.name, name), eq(sharedSkills.version, version)))
      .limit(1);

    if (existing) {
      if (existing.status === 'rejected') {
        // 被拒版本复用：重置为 pending（归档字节随之重建为校验和）。
        await this.db
          .update(sharedSkills)
          .set({
            displayName,
            description,
            checksum,
            status: 'pending',
            reason: '',
            updatedAt: new Date(),
          })
          .where(eq(sharedSkills.id, existing.id));
        return { name, version, status: 'pending' };
      }
      throw new ApiError('VALIDATION', '该版本已存在', 400);
    }

    await this.db.insert(sharedSkills).values({
      name,
      displayName,
      version,
      description,
      author: username,
      checksum,
      status: 'pending',
      reason: '',
    });
    await this.audit.log(username, 'shared_skill_upload', `${name}@${version}`);
    return { name, version, status: 'pending' };
  }

  /** 员工面：归档下载（三闸：审核 + 上架 + 授权；未授权 404 不泄露存在性）。 */
  async downloadForEmployee(
    name: string,
    version: string,
    username: string,
    role: string,
    userId: number,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(sharedSkills)
      .where(and(eq(sharedSkills.name, name), eq(sharedSkills.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');

    if (!this.adminFull(role)) {
      if (row.author !== username) {
        if (row.status !== 'approved') {
          throw new ApiError('NOT_FOUND', '技能不存在');
        }
        const groups = await resolveUserGroupNames(this.db, userId);
        const [g] = await this.db
          .select()
          .from(sharedSkillGrants)
          .where(
            and(
              eq(sharedSkillGrants.skillName, name),
              granteeMatch(username, groups),
            ),
          )
          .limit(1);
        if (!g) throw new ApiError('NOT_FOUND', '技能不存在');
      }
    }
    throw new ApiError('NOT_FOUND', '归档文件未存储');
  }

  // ------------------------------------------------------------ admin

  /** 管理面：全量清单（status 过滤可选）。 */
  async listAll(status?: string): Promise<SharedSkillJSON[]> {
    const rows = await this.db
      .select()
      .from(sharedSkills)
      .where(
        status
          ? eq(sharedSkills.status, status as SharedSkill['status'])
          : undefined,
      )
      .orderBy(sharedSkills.name, sharedSkills.version);
    return rows.map((r) => this.toJSON(r));
  }

  async download(name: string, version: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(sharedSkills)
      .where(and(eq(sharedSkills.name, name), eq(sharedSkills.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    throw new ApiError('NOT_FOUND', '归档文件未存储');
  }

  async preview(name: string, version: string): Promise<{
    files: unknown[];
    skill_md: string;
  }> {
    const [row] = await this.db
      .select()
      .from(sharedSkills)
      .where(and(eq(sharedSkills.name, name), eq(sharedSkills.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    return { files: [], skill_md: '' };
  }

  async approve(name: string, version: string, username: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(sharedSkills)
      .where(and(eq(sharedSkills.name, name), eq(sharedSkills.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');

    // 市场同名冲突（审核时二次校验：市场技能可能在上传后才创建）。
    const [market] = await this.db
      .select({ name: skills.name })
      .from(skills)
      .where(eq(skills.name, name))
      .limit(1);
    if (market) {
      throw new ApiError(
        'CONFLICT',
        '名称与市场技能冲突,请先处理市场技能或驳回该共享技能',
      );
    }
    // 拒绝即释放存储：被拒版本归档已清空，无法再通过审核。
    if (row.status === 'rejected') {
      throw new ApiError(
        'ARCHIVE_CLEARED',
        '该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本',
      );
    }
    await this.db
      .update(sharedSkills)
      .set({ status: 'approved', reason: '', updatedAt: new Date() })
      .where(eq(sharedSkills.id, row.id));
    await this.audit.log(username, 'shared_skill_approve', `${name}@${version}`);
  }

  async reject(
    name: string,
    version: string,
    reason: string,
    username: string,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(sharedSkills)
      .where(and(eq(sharedSkills.name, name), eq(sharedSkills.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    if (!reason || reason.trim() === '') {
      throw new ApiError('VALIDATION', '请填写拒绝理由', 400);
    }
    if (reason.length > MAX_REASON_LEN) {
      throw new ApiError('VALIDATION', '拒绝理由过长(上限 500 字)', 400);
    }
    if (row.status === 'approved') {
      throw new ApiError(
        'APPROVED_NOT_REJECTABLE',
        '已审核通过的版本不可驳回',
      );
    }
    // 拒绝 + 清空归档（同一 UPDATE；重写版归档 = checksum）。
    await this.db
      .update(sharedSkills)
      .set({ status: 'rejected', reason, checksum: '', updatedAt: new Date() })
      .where(eq(sharedSkills.id, row.id));
    await this.audit.log(username, 'shared_skill_reject', `${name}@${version}`);
  }

  async deleteVersion(
    name: string,
    version: string,
    username: string,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(sharedSkills)
      .where(and(eq(sharedSkills.name, name), eq(sharedSkills.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    await this.db.delete(sharedSkills).where(eq(sharedSkills.id, row.id));
    // 最后一个版本消失时清理 name 级授权。
    const remaining = await this.db
      .select({ id: sharedSkills.id })
      .from(sharedSkills)
      .where(eq(sharedSkills.name, name))
      .limit(1);
    if (remaining.length === 0) {
      await this.db
        .delete(sharedSkillGrants)
        .where(eq(sharedSkillGrants.skillName, name));
    }
    await this.audit.log(username, 'shared_skill_delete', `${name}@${version}`);
  }

  async setQuality(
    name: string,
    version: string,
    quality: string,
    username: string,
  ): Promise<{ quality: string }> {
    const [row] = await this.db
      .select()
      .from(sharedSkills)
      .where(and(eq(sharedSkills.name, name), eq(sharedSkills.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    if (quality !== '' && quality !== 'featured') {
      throw new ApiError(
        'VALIDATION',
        '质量标记不合法(空/featured;官方已移交归属官方操作)',
        400,
      );
    }
    if (row.status !== 'approved') {
      throw new ApiError('VALIDATION', '仅审核通过的版本可设置质量标记', 400);
    }
    // 无 quality 列 → 校验后 no-op。
    await this.audit.log(username, 'shared_skill_quality', `${name}@${version}`);
    return { quality };
  }

  async file(
    name: string,
    version: string,
    path: string,
  ): Promise<{ path: string; size: number; binary: boolean; too_large: boolean; content: string }> {
    const [row] = await this.db
      .select()
      .from(sharedSkills)
      .where(and(eq(sharedSkills.name, name), eq(sharedSkills.version, version)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
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
      .from(sharedSkills)
      .where(eq(sharedSkills.name, name))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '技能不存在');
    // 无 enabled 列 → 校验 + 审计 no-op。
    await this.audit.log(
      username,
      body.enabled ? 'shared_skill_enable' : 'shared_skill_disable',
      name,
    );
    return { enabled: body.enabled };
  }

  // ------------------------------------------------------------ grants

  async listGrants(name: string): Promise<SharedSkillGrantJSON[]> {
    const rows = await this.db
      .select()
      .from(sharedSkillGrants)
      .where(eq(sharedSkillGrants.skillName, name))
      .orderBy(sharedSkillGrants.granteeType, sharedSkillGrants.grantee);
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
        .delete(sharedSkillGrants)
        .where(
          and(
            eq(sharedSkillGrants.skillName, name),
            eq(sharedSkillGrants.granteeType, 'group'),
          ),
        );
      for (const g of cleaned) {
        await tx
          .insert(sharedSkillGrants)
          .values({ skillName: name, granteeType: 'group', grantee: g })
          .onConflictDoNothing();
      }
    });
    await this.audit.log(username, 'shared_skill_grants_replace', name);
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
      .insert(sharedSkillGrants)
      .values({ skillName: name, granteeType, grantee })
      .onConflictDoNothing();
    await this.audit.log(username, 'shared_skill_grant', `${name}:${granteeType}:${grantee}`);
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
      .delete(sharedSkillGrants)
      .where(
        and(
          eq(sharedSkillGrants.skillName, name),
          eq(sharedSkillGrants.granteeType, granteeType),
          eq(sharedSkillGrants.grantee, grantee),
        ),
      );
    await this.audit.log(username, 'shared_skill_revoke', `${name}:${granteeType}:${grantee}`);
  }
}
