import { eq } from 'drizzle-orm';
import type { Database } from '../db/database.module';
import { groups, userGroups } from '../db/schema';

export const EVERYONE_GROUP_NAME = '全员';

interface GroupRow {
  id: number;
  name: string;
  parentId: number;
  leaderId: number;
}

/**
 * 解析用户的有效部门集合（与 Go serverstore.UserEffectiveGroups 对齐）：
 * 直属部门 + 其祖先链 + 作为 leader 的子树 + 隐式「全员」组。
 * 返回部门名列表（含全员组名，若存在）。
 */
export async function resolveUserEffectiveGroups(db: Database, userId: number): Promise<string[]> {
  const all = await db
    .select({
      id: groups.id,
      name: groups.name,
      parentId: groups.parentId,
      leaderId: groups.leaderId,
    })
    .from(groups);
  const memberships = await db
    .select({ groupId: userGroups.groupId })
    .from(userGroups)
    .where(eq(userGroups.userId, userId));

  const byId = new Map<number, GroupRow>();
  const children = new Map<number, number[]>();
  for (const g of all) {
    byId.set(g.id, g);
    const list = children.get(g.parentId) ?? [];
    list.push(g.id);
    children.set(g.parentId, list);
  }

  const effective = new Set<number>();

  // 直属部门 + 祖先链
  for (const m of memberships) {
    let cur = m.groupId;
    const seen = new Set<number>();
    while (cur > 0 && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      effective.add(cur);
      cur = byId.get(cur)!.parentId;
    }
  }

  // 作为 leader 的整棵子树
  for (const g of all) {
    if (g.leaderId === userId) {
      const visited = new Set<number>();
      const stack = [g.id];
      while (stack.length) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        effective.add(id);
        for (const c of children.get(id) ?? []) stack.push(c);
      }
    }
  }

  // 隐式「全员」组
  for (const g of all) {
    if (g.name === EVERYONE_GROUP_NAME) effective.add(g.id);
  }

  const names: string[] = [];
  for (const id of effective) {
    const g = byId.get(id);
    if (g) names.push(g.name);
  }
  return names;
}
