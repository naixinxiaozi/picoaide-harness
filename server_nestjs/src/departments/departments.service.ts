import { Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/database.module';
import { appGrants, groups, userGroups, users } from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import { AuditService } from '../audit/audit.service';

const RESERVED_GROUP_NAME = '全员';

export interface DepartmentInfo {
  id: number;
  name: string;
  parent_id: number;
  leader_id: number;
  leader_name?: string;
  description: string;
  member_count: number;
  child_count: number;
  granted_count: number;
  level: number
  children?: DepartmentInfo[] | null
}

export interface DeptBody {
  name?: string;
  parent_id?: number;
  leader_id?: number;
  description?: string;
}

interface GroupRow {
  id: number;
  name: string;
  parentId: number;
  leaderId: number;
  description: string;
}

@Injectable()
export class DepartmentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<DepartmentInfo[]> {
    const rows = await this.db.execute<{
      id: number;
      name: string;
      parent_id: number;
      leader_id: number;
      leader_name: string;
      description: string;
      member_count: number;
      child_count: number;
      granted_count: number;
    }>(sql`
      SELECT
        g.id,
        g.name,
        g.parent_id,
        g.leader_id,
        g.description,
        COALESCE(u.username, '') AS leader_name,
        (SELECT COUNT(*)::int FROM user_groups ug WHERE ug.group_id = g.id) AS member_count,
        (SELECT COUNT(*)::int FROM groups c WHERE c.parent_id = g.id) AS child_count,
        (
          SELECT COUNT(*)::int FROM app_grants ag
          WHERE ag.grantee_type = 'group' AND LOWER(ag.grantee) = LOWER(g.name)
        ) AS granted_count
      FROM groups g
      LEFT JOIN users u ON u.id = g.leader_id
      ORDER BY g.id
    `);

    const deps: DepartmentInfo[] = [];
    for (const r of rows) {
      const d: DepartmentInfo = {
        id: Number(r.id),
        name: r.name,
        parent_id: Number(r.parent_id),
        leader_id: Number(r.leader_id),
        description: r.description,
        member_count: Number(r.member_count),
        child_count: Number(r.child_count),
        granted_count: Number(r.granted_count),
        level: 0
      };
      if (r.leader_name) d.leader_name = r.leader_name;
      deps.push(d);
    }
    return arrayToTree(deps);
  }

  async create(body: DeptBody, actor: string): Promise<{ id: number; name: string }> {
    const name = (body.name ?? '').trim();
    if (name === '') throw new ApiError('VALIDATION', '部门名称必填', 400);

    const parentId = Number(body.parent_id ?? 0) || 0;
    const leaderId = Number(body.leader_id ?? 0) || 0;
    const description = body.description ?? '';

    if (name === RESERVED_GROUP_NAME) throw new ApiError('INTERNAL', '创建失败', 500);

    return this.db.transaction(async (tx) => {
      if (parentId !== 0) {
        const parent = await tx
          .select({ id: groups.id })
          .from(groups)
          .where(eq(groups.id, parentId))
          .limit(1);
        if (parent.length === 0) throw new ApiError('NOT_FOUND', '上级部门或主管不存在', 404);
      }
      if (leaderId !== 0) {
        const leader = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, leaderId))
          .limit(1);
        if (leader.length === 0) throw new ApiError('NOT_FOUND', '上级部门或主管不存在', 404);
      }

      const dup = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(sql`LOWER(${groups.name}) = LOWER(${name})`)
        .limit(1);
      if (dup.length > 0) throw new ApiError('VALIDATION', '部门名称已存在', 400);

      const inserted = await tx
        .insert(groups)
        .values({
          name,
          parentId,
          leaderId,
          description,
        })
        .returning({ id: groups.id });

      await this.audit.log(actor, 'dept_create', `name=${name}`);
      return { id: inserted[0].id, name };
    }).catch((e: unknown) => {
      throw mapUniqueViolation(e);
    });
  }

  async update(idRaw: string, body: DeptBody, actor: string): Promise<{ id: number; name: string }> {
    const id = this.parseId(idRaw);

    const name = (body.name ?? '').trim();
    if (name === '') throw new ApiError('VALIDATION', '部门名称必填', 400);

    const parentId = Number(body.parent_id ?? 0) || 0;
    const leaderId = Number(body.leader_id ?? 0) || 0;
    const description = body.description ?? '';

    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: groups.id, name: groups.name, parentId: groups.parentId, leaderId: groups.leaderId })
        .from(groups)
        .where(eq(groups.id, id))
        .limit(1);
      if (existing.length === 0) throw new ApiError('NOT_FOUND', '部门不存在', 404);
      const old = existing[0];

      // Reserved name / empty (empty already handled) → cycle-validation message per Go mapping.
      if (old.name === RESERVED_GROUP_NAME || name === RESERVED_GROUP_NAME) {
        throw new ApiError('VALIDATION', '上级部门不能是自身或子部门', 400);
      }

      if (parentId !== 0) {
        if (parentId === id) throw new ApiError('VALIDATION', '上级部门不能是自身或子部门', 400);
        const parent = await tx
          .select({ id: groups.id })
          .from(groups)
          .where(eq(groups.id, parentId))
          .limit(1);
        if (parent.length === 0) throw new ApiError('NOT_FOUND', '上级部门或主管不存在', 404);
        const subtree = await this.subtreeIds(id);
        if (subtree.has(parentId)) throw new ApiError('VALIDATION', '上级部门不能是自身或子部门', 400);
      }
      if (leaderId !== 0) {
        const leader = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, leaderId))
          .limit(1);
        if (leader.length === 0) throw new ApiError('NOT_FOUND', '上级部门或主管不存在', 404);
      }

      if (name !== old.name) {
        const dup = await tx
          .select({ id: groups.id })
          .from(groups)
          .where(sql`LOWER(${groups.name}) = LOWER(${name})`)
          .limit(1);
        if (dup.length > 0) throw new ApiError('VALIDATION', '部门名称已存在', 400);
      }

      await tx
        .update(groups)
        .set({ name, parentId, leaderId, description })
        .where(eq(groups.id, id));

      // Cascade group renames across the unified grant table (mirrors Go app_grants rename).
      if (name !== old.name) {
        await tx.execute(sql`UPDATE app_grants SET grantee = ${name} WHERE grantee_type = 'group' AND LOWER(grantee) = LOWER(${old.name})`);
      }

      await this.audit.log(
        actor,
        'dept_update',
        `${old.name}→${name} parent:${old.parentId}→${parentId} leader:${old.leaderId}→${leaderId}`,
      );
      return { id, name };
    }).catch((e: unknown) => {
      throw mapUniqueViolation(e);
    });
  }

  async remove(idRaw: string, actor: string): Promise<void> {
    const id = this.parseId(idRaw);

    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: groups.id, name: groups.name })
        .from(groups)
        .where(eq(groups.id, id))
        .limit(1);
      if (existing.length === 0) throw new ApiError('NOT_FOUND', '部门不存在', 404);
      const g = existing[0];

      if (g.name === RESERVED_GROUP_NAME) throw new ApiError('VALIDATION', '保留部门不可删除', 400);

      const memberCount = Number(
        (await tx.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM user_groups WHERE group_id = ${id}`))[0].c,
      );
      const childCount = Number(
        (await tx.execute<{ c: number }>(sql`SELECT COUNT(*)::int AS c FROM groups WHERE parent_id = ${id}`))[0].c,
      );
      const grantCount = Number(
        (await tx.execute<{ c: number }>(sql`
          SELECT COUNT(*)::int AS c FROM app_grants
          WHERE grantee_type = 'group' AND LOWER(grantee) = LOWER(${g.name})
        `))[0].c,
      );

      if (memberCount > 0 || childCount > 0 || grantCount > 0) {
        throw new ApiError('VALIDATION', '部门仍有关联(成员/子部门/授权),请先转移或清理', 400);
      }

      await tx.delete(groups).where(eq(groups.id, id));
      await this.audit.log(actor, 'dept_delete', `name=${g.name}`);
    });
  }

  private parseId(raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new ApiError('VALIDATION', '非法部门 ID', 400);
    return n;
  }

  private async subtreeIds(rootId: number): Promise<Set<number>> {
    const all = await this.db
      .select({ id: groups.id, parentId: groups.parentId })
      .from(groups);
    const children = new Map<number, number[]>();
    for (const g of all) {
      const list = children.get(g.parentId) ?? [];
      list.push(g.id);
      children.set(g.parentId, list);
    }
    const result = new Set<number>();
    const stack = [rootId];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const c of children.get(cur) ?? []) {
        if (!result.has(c)) {
          result.add(c);
          stack.push(c);
        }
      }
    }
    return result;
  }
}

function arrayToTree(arr: DepartmentInfo[], pid = 0) {
  const newArr: DepartmentInfo[] = []
  arr.forEach((v) => {
    if (v.parent_id === pid) {
      const children = arrayToTree(arr, v.id)
      newArr.push({
        ...v,
        level: v.level + 1,
        children: children.length > 0 ? children : null
      })
    }
  })

  return newArr
}

/** 唯一索引冲突（PG 23505）→ 400 部门名称已存在；其余原样抛出。 */
function mapUniqueViolation(e: unknown): unknown {
  const code = (e as { code?: string } | null)?.code;
  if (code === '23505') return new ApiError('VALIDATION', '部门名称已存在', 400);
  return e;
}
