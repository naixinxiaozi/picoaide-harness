import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { ApiError } from '../common/errors/api-error';
import { beijingMonthStartUTC, beijingParts, rfc3339UTC } from '../common/time';
import { DRIZZLE, Database } from '../db/database.module';
import {
  adminSessions,
  apiTokens,
  balanceGrantItems,
  balanceLedger,
  groups,
  usage,
  usageDaily,
  usageMonthly,
  userGroups,
  users,
  type UserRole,
} from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';

const MAX_USERNAME_BYTES = 128;
const MAX_PAGE = 100000;
const TOKEN_DEFAULT_SIZE = 50;
const TOKEN_MAX_SIZE = 200;
const VALID_ROLES: UserRole[] = ['super_admin', 'auditor', 'user'];

interface Actor {
  userId: number;
  username: string;
}

interface ListParams {
  page?: string;
  size?: string;
  q?: string;
}

interface CreateUserBody {
  username?: string;
  password?: string;
  role?: string;
  is_admin?: boolean;
  status?: number;
}

interface UpdateUserBody {
  display_name?: string | null;
  email?: string | null;
  password?: string | null;
  role?: string | null;
  is_admin?: boolean | null;
  status?: number | null;
}

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly usersService: UsersService,
    private readonly settings: SettingsService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async list(params: ListParams) {
    const { page, size } = this.paginate(params.page, params.size, 20, 200);
    const offset = (page - 1) * size;
    const q = (params.q ?? '').trim();

    const cond = q
      ? sql`POSITION(lower(${q}) IN lower(${users.username})) > 0`
      : undefined;

    const totalRow = cond
      ? await this.db.execute<{ cnt: number }>(
          sql`SELECT COUNT(*)::int AS cnt FROM users WHERE ${cond}`,
        )
      : await this.db.execute<{ cnt: number }>(
          sql`SELECT COUNT(*)::int AS cnt FROM users`,
        );
    const total = Number(totalRow[0]?.cnt ?? 0);

    const rows = cond
      ? await this.db
          .select()
          .from(users)
          .where(cond)
          .orderBy(asc(users.id))
          .limit(size)
          .offset(offset)
      : await this.db
          .select()
          .from(users)
          .orderBy(asc(users.id))
          .limit(size)
          .offset(offset);

    const ids = rows.map((u) => u.id);
    const groupsByUser = await this.groupsBatch(ids);
    const usageByUser = await this.monthlyUsageBatch(ids);
    const costByUser = await this.monthlyCostBatch(ids);

    const out = rows.map((u) => ({
      ...this.usersService.toUserJSON(u),
      groups: groupsByUser.get(u.id) ?? [],
      monthly_usage: usageByUser.get(u.id) ?? 0,
      monthly_cost: costByUser.get(u.id) ?? 0,
    }));

    return { users: out, total, page, size };
  }

  async getGroups(idRaw: string) {
    const id = this.parseId(idRaw, '非法用户 ID');
    const target = await this.usersService.findById(id);
    if (!target) throw new ApiError('NOT_FOUND', '用户不存在', 404);

    const rows = await this.db.execute<{ name: string }>(sql`
      SELECT g.name
      FROM groups g
      JOIN user_groups ug ON ug.group_id = g.id
      WHERE ug.user_id = ${id}
      ORDER BY g.name
    `);
    return { groups: rows.map((r) => r.name) };
  }

  async create(body: CreateUserBody, actor: Actor) {
    const username = (body.username ?? '').trim();
    const password = body.password ?? '';
    if (!username || !password) {
      throw new ApiError('VALIDATION', '用户名和密码必填', 400);
    }

    const minLength = await this.settings.authMinPasswordLength();
    if ([...password].length < minLength) {
      throw new ApiError('VALIDATION', `密码至少 ${minLength} 位`, 400);
    }

    let status = body.status ?? 0;
    if (status === 0) status = 1;
    if (status !== 0 && status !== 1) {
      throw new ApiError('VALIDATION', 'status 只能是 0 或 1', 400);
    }

    let role = (body.role ?? '').trim();
    if (role === '') {
      role = body.is_admin ? 'super_admin' : 'user';
    }
    if (!VALID_ROLES.includes(role as UserRole)) {
      throw new ApiError('VALIDATION', 'role 必须是 super_admin/auditor/user', 400);
    }

    if (Buffer.byteLength(username, 'utf8') > MAX_USERNAME_BYTES) {
      throw new ApiError(
        'VALIDATION',
        `用户名过长（最多 ${MAX_USERNAME_BYTES} 字节）`,
        400,
      );
    }

    const dup = await this.db.execute<{ one: number }>(sql`
      SELECT 1 AS one FROM users WHERE lower(username) = lower(${username}) LIMIT 1
    `);
    if (dup.length > 0) {
      throw new ApiError('VALIDATION', '用户名已存在', 400);
    }

    const hash = await this.crypto.hashPassword(password);

    const [created] = await this.db
      .insert(users)
      .values({
        username,
        displayName: null,
        email: null,
        passwordHash: hash,
        source: 'local',
        isAdmin: role === 'super_admin' ? 1 : 0,
        role: role as UserRole,
        status,
      })
      .returning();

    await this.audit.log(actor.username, 'user_create', created.username);
    return { user: this.usersService.toUserJSON(created) };
  }

  async update(idRaw: string, body: UpdateUserBody, actor: Actor) {
    const id = this.parseId(idRaw, '非法用户 ID');
    const target = await this.usersService.findById(id);
    if (!target) throw new ApiError('NOT_FOUND', '用户不存在', 404);

    const wasRole = target.role;
    const wasStatus = target.status;
    const wasSuperAdmin = target.role === 'super_admin';

    // Resolve new role: explicit role wins; is_admin alias maps to
    // super_admin/user; otherwise unchanged.
    let newRole = target.role;
    if (body.role !== undefined && body.role !== null && body.role !== '') {
      if (!VALID_ROLES.includes(body.role as UserRole)) {
        throw new ApiError('VALIDATION', 'role 必须是 super_admin/auditor/user', 400);
      }
      newRole = body.role as UserRole;
    } else if (body.is_admin !== undefined && body.is_admin !== null) {
      newRole = body.is_admin ? 'super_admin' : 'user';
    }

    if (newRole !== 'super_admin' && wasSuperAdmin && actor.userId === target.id) {
      throw new ApiError('VALIDATION', '不能取消自己的管理员权限', 400);
    }
    if (
      body.status !== undefined &&
      body.status !== null &&
      body.status !== 1 &&
      wasSuperAdmin &&
      actor.userId === target.id
    ) {
      throw new ApiError('VALIDATION', '不能禁用自己', 400);
    }

    let passwordHash: string | null = null;
    let passwordMustChange = target.passwordMustChange === 1;
    let passwordChangedAt: Date | null = target.passwordChangedAt ?? null;

    if (body.password !== undefined && body.password !== null && body.password !== '') {
      if (target.source !== 'local') {
        throw new ApiError(
          'VALIDATION',
          '外部认证用户的密码由企业 IdP 管理,不能在此修改',
          400,
        );
      }
      const minLength = await this.settings.authMinPasswordLength();
      if ([...body.password].length < minLength) {
        throw new ApiError('VALIDATION', `密码至少 ${minLength} 位`, 400);
      }
      passwordHash = await this.crypto.hashPassword(body.password);
      passwordMustChange = true;
      passwordChangedAt = new Date();
    }

    const roleChanged = wasRole !== newRole;
    const demote =
      (passwordHash !== null) ||
      roleChanged ||
      (body.status !== undefined && body.status !== null && body.status !== 1 && wasStatus === 1);

    const updateValues: Record<string, unknown> = {
      isAdmin: newRole === 'super_admin' ? 1 : 0,
      role: newRole,
    };
    if (body.display_name !== undefined && body.display_name !== null) {
      updateValues['displayName'] = body.display_name;
    }
    if (body.email !== undefined && body.email !== null) {
      updateValues['email'] = body.email;
    }
    if (passwordHash !== null) {
      updateValues['passwordHash'] = passwordHash;
      updateValues['passwordMustChange'] = 1;
      updateValues['passwordChangedAt'] = passwordChangedAt;
    }
    if (body.status !== undefined && body.status !== null) {
      updateValues['status'] = body.status;
    }

    await this.db.transaction(async (tx) => {
      await tx.update(users).set(updateValues).where(eq(users.id, id));
      if (demote) {
        await tx.delete(apiTokens).where(eq(apiTokens.userId, id));
        await tx.delete(adminSessions).where(eq(adminSessions.userId, id));
      }
    });

    if (demote) {
      await this.audit.log(actor.username, 'user_tokens_revoked', target.username);
    }
    if (roleChanged) {
      await this.audit.log(
        actor.username,
        'role_change',
        `${target.username}@${wasRole}→${newRole}`,
      );
    } else {
      await this.audit.log(actor.username, 'user_update', target.username);
    }

    const refreshed = await this.usersService.findById(id);
    return { user: this.usersService.toUserJSON(refreshed!) };
  }

  async remove(idRaw: string, actor: Actor) {
    const id = this.parseId(idRaw, '非法用户 ID');
    const target = await this.usersService.findById(id);
    if (!target) throw new ApiError('NOT_FOUND', '用户不存在', 404);
    if (actor.userId === target.id) {
      throw new ApiError('VALIDATION', '不能删除自己', 400);
    }

    const erased = await this.db.transaction(async (tx) => {
      const wasSuperAdmin = target.role === 'super_admin';
      if (wasSuperAdmin) {
        await tx.execute(sql`SELECT id FROM users WHERE role = 'super_admin' FOR UPDATE`);
      }

      const usageAgg = await tx.execute<{ cost: number; cnt: number }>(sql`
        SELECT COALESCE(SUM(cost),0)::float8 AS cost, COUNT(*)::int AS cnt
        FROM usage WHERE user_id = ${id}
      `);
      const balAgg = await tx.execute<{ amt: number; cnt: number }>(sql`
        SELECT COALESCE(SUM(amount),0)::float8 AS amt, COUNT(*)::int AS cnt
        FROM balance_ledger WHERE user_id = ${id}
      `);

      await tx.delete(apiTokens).where(eq(apiTokens.userId, id));
      await tx.delete(usage).where(eq(usage.userId, id));
      await tx.delete(usageDaily).where(eq(usageDaily.userId, id));
      await tx.delete(usageMonthly).where(eq(usageMonthly.userId, id));
      await tx.delete(balanceLedger).where(eq(balanceLedger.userId, id));
      await tx.delete(balanceGrantItems).where(eq(balanceGrantItems.userId, id));
      await tx.delete(adminSessions).where(eq(adminSessions.userId, id));
      await tx.delete(userGroups).where(eq(userGroups.userId, id));

      await tx.execute(
        sql`DELETE FROM app_grants WHERE grantee_type = 'user' AND lower(grantee) = lower(${target.username})`,
      );
      await tx.execute(sql`UPDATE groups SET leader_id = 0 WHERE leader_id = ${id}`);

      await tx.delete(users).where(eq(users.id, id));

      if (wasSuperAdmin) {
        const remaining = await tx.execute<{ cnt: number }>(sql`
          SELECT COUNT(*)::int AS cnt FROM users WHERE role = 'super_admin'
        `);
        if (Number(remaining[0]?.cnt ?? 0) === 0) {
          throw new ApiError('VALIDATION', '不能删除最后一个管理员', 400);
        }
      }

      return {
        usageCost: Number(usageAgg[0]?.cost ?? 0),
        usageRequests: Number(usageAgg[0]?.cnt ?? 0),
        balanceAmount: Number(balAgg[0]?.amt ?? 0),
        balanceRows: Number(balAgg[0]?.cnt ?? 0),
      };
    });

    const detail = `${target.username}（抹除用量 ${erased.usageCost.toFixed(
      2,
    )} 元/${erased.usageRequests} 笔、余额流水 ${erased.balanceAmount.toFixed(
      2,
    )} 元/${erased.balanceRows} 笔）`;
    await this.audit.log(actor.username, 'user_delete', detail);

    return { ok: true };
  }

  async resetMfa(idRaw: string, actor: Actor) {
    const id = this.parseId(idRaw, '非法用户 ID');
    if (actor.userId === id) {
      throw new ApiError(
        'VALIDATION',
        '不能重置自己的 MFA,请在「安全设置」中关闭',
        400,
      );
    }
    const target = await this.usersService.findById(id);
    if (!target) throw new ApiError('NOT_FOUND', '用户不存在', 404);

    await this.db.update(users).set({ totpSecret: '', totpEnabled: 0 }).where(eq(users.id, id));
    await this.db.delete(apiTokens).where(eq(apiTokens.userId, id));
    await this.db.delete(adminSessions).where(eq(adminSessions.userId, id));

    await this.audit.log(actor.username, 'admin_mfa_reset', target.username);
    return { ok: true };
  }

  async setDepartment(
    idRaw: string,
    body: Record<string, unknown>,
    actor: Actor,
  ) {
    const id = this.parseId(idRaw, '非法用户 ID');
    const target = await this.usersService.findById(id);
    if (!target) throw new ApiError('NOT_FOUND', '用户不存在', 404);

    const allowed = new Set(['group_ids', 'group_id']);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) {
        throw new ApiError(
          'VALIDATION',
          '请求体格式错误(仅接受 group_ids 数组或 group_id)',
          400,
        );
      }
    }

    const groupIdsRaw = body['group_ids'];
    const groupIdRaw = body['group_id'];
    let ids: number[] = [];
    if (Array.isArray(groupIdsRaw)) {
      ids = groupIdsRaw.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    } else if (typeof groupIdRaw === 'number' && groupIdRaw > 0) {
      ids = [groupIdRaw];
    }

    const unique: number[] = [];
    const seen = new Set<number>();
    const names: string[] = [];
    for (const gid of ids) {
      if (seen.has(gid) || gid <= 0) continue;
      seen.add(gid);
      const g = await this.db.query.groups.findFirst({ where: eq(groups.id, gid) });
      if (!g) throw new ApiError('VALIDATION', '部门不存在', 400);
      unique.push(gid);
      names.push(g.name);
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(userGroups).where(eq(userGroups.userId, id));
      for (const gid of unique) {
        await tx.insert(userGroups).values({ userId: id, groupId: gid }).onConflictDoNothing();
      }
    });

    await this.audit.log(
      actor.username,
      'user_dept',
      `${target.username} → [${names.join(',')}]`,
    );
    return { ok: true };
  }

  async listTokens(idRaw: string, pageRaw?: string, sizeRaw?: string) {
    const id = this.parseId(idRaw, '非法用户 ID');
    const { page, size } = this.parseTokenPageQuery(pageRaw, sizeRaw);
    const target = await this.usersService.findById(id);
    if (!target) throw new ApiError('NOT_FOUND', '用户不存在', 404);

    const totalRow = await this.db.execute<{ cnt: number }>(sql`
      SELECT COUNT(*)::int AS cnt FROM api_tokens WHERE user_id = ${id}
    `);
    const total = Number(totalRow[0]?.cnt ?? 0);

    const rows = await this.db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        createdAt: apiTokens.createdAt,
        expiresAt: apiTokens.expiresAt,
        lastUsedAt: apiTokens.lastUsedAt,
        revoked: apiTokens.revoked,
      })
      .from(apiTokens)
      .where(eq(apiTokens.userId, id))
      .orderBy(desc(apiTokens.id))
      .limit(size)
      .offset((page - 1) * size);

    const tokens = rows.map((t) => ({
      id: t.id,
      name: t.name,
      created_at: rfc3339UTC(t.createdAt),
      expires_at: rfc3339UTC(t.expiresAt),
      last_used_at: t.lastUsedAt ? rfc3339UTC(t.lastUsedAt) : '',
      revoked: t.revoked,
    }));

    return {
      tokens,
      page,
      size,
      total,
      has_more: (page - 1) * size + tokens.length < total,
    };
  }

  async revokeToken(idRaw: string) {
    const id = this.parseId(idRaw, '非法令牌 ID');
    const updated = await this.db
      .update(apiTokens)
      .set({ revoked: 1 })
      .where(eq(apiTokens.id, id))
      .returning({ id: apiTokens.id });
    if (updated.length === 0) {
      throw new ApiError('NOT_FOUND', '令牌不存在', 404);
    }
    return { ok: true };
  }

  // --- helpers ---

  private parseId(raw: string, message: string): number {
    if (!/^-?\d+$/.test(raw)) throw new ApiError('VALIDATION', message, 400);
    const id = Number(raw);
    if (!Number.isSafeInteger(id)) throw new ApiError('VALIDATION', message, 400);
    return id;
  }

  private paginate(
    pageRaw: string | undefined,
    sizeRaw: string | undefined,
    defaultSize: number,
    maxSize: number,
  ): { page: number; size: number } {
    let page = Number.parseInt(pageRaw ?? '', 10);
    if (Number.isNaN(page) || page < 1) page = 1;
    if (page > MAX_PAGE) page = MAX_PAGE;
    let size = Number.parseInt(sizeRaw ?? '', 10);
    if (Number.isNaN(size) || size < 1 || size > maxSize) size = defaultSize;
    return { page, size };
  }

  private parseTokenPageQuery(
    pageRaw: string | undefined,
    sizeRaw: string | undefined,
  ): { page: number; size: number } {
    let page = 1;
    let size = TOKEN_DEFAULT_SIZE;
    if (pageRaw !== undefined && pageRaw !== '') {
      const v = Number.parseInt(pageRaw, 10);
      if (Number.isNaN(v) || v < 1 || v > MAX_PAGE) {
        throw new ApiError('VALIDATION', `page 必须是 1..${MAX_PAGE} 的整数`, 400);
      }
      page = v;
    }
    if (sizeRaw !== undefined && sizeRaw !== '') {
      const v = Number.parseInt(sizeRaw, 10);
      if (Number.isNaN(v) || v < 1 || v > TOKEN_MAX_SIZE) {
        throw new ApiError('VALIDATION', `size 必须是 1..${TOKEN_MAX_SIZE} 的整数`, 400);
      }
      size = v;
    }
    return { page, size };
  }

  private async groupsBatch(ids: number[]): Promise<Map<number, string[]>> {
    const map = new Map<number, string[]>();
    if (ids.length === 0) return map;
    const rows = await this.db
      .select({ userId: userGroups.userId, name: groups.name })
      .from(userGroups)
      .innerJoin(groups, eq(groups.id, userGroups.groupId))
      .where(inArray(userGroups.userId, ids))
      .orderBy(asc(groups.name));
    for (const r of rows) {
      const uid = Number(r.userId);
      const arr = map.get(uid) ?? [];
      arr.push(r.name);
      map.set(uid, arr);
    }
    return map;
  }

  private async monthlyUsageBatch(ids: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (ids.length === 0) return map;
    const now = new Date();
    const parts = beijingParts(now);
    const monthStart = beijingMonthStartUTC(parts.year, parts.month);
    const rows = await this.db
      .select({
        userId: usage.userId,
        total: sql<string>`COALESCE(SUM(${usage.promptTokens}),0) + COALESCE(SUM(${usage.completionTokens}),0)`,
      })
      .from(usage)
      .where(and(gte(usage.createdAt, monthStart), inArray(usage.userId, ids)))
      .groupBy(usage.userId);
    for (const r of rows) {
      map.set(Number(r.userId), Number(r.total));
    }
    return map;
  }

  private async monthlyCostBatch(ids: number[]): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (ids.length === 0) return map;
    const now = new Date();
    const parts = beijingParts(now);
    const monthStart = beijingMonthStartUTC(parts.year, parts.month);
    const rows = await this.db
      .select({
        userId: usage.userId,
        total: sql<string>`COALESCE(SUM(${usage.cost}),0)`,
      })
      .from(usage)
      .where(and(gte(usage.createdAt, monthStart), inArray(usage.userId, ids)))
      .groupBy(usage.userId);
    for (const r of rows) {
      map.set(Number(r.userId), Number(r.total));
    }
    return map;
  }
}
