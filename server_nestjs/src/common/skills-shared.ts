import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/database.module';
import { groups, userGroups } from '../db/schema';

/**
 * 技能/Agent 域共享工具：应用 ID/版本校验、授权语义、部门解析、时间格式化。
 * 对应 Go server/internal/skillmanifest/manifest.go + serverstore/grants.go 的口径。
 */

/** App ID 规则（与 limits.AppIDPattern 逐字对齐）：^[a-z0-9]+(?:-[a-z0-9]+)*$。 */
const APP_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Windows 保留设备名首段（con/prn/aux/nul/com1-9/lpt1-9，大小写不敏感）。 */
const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 版本规则（semver + 可选 prerelease）。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export const MIN_APP_ID_LEN = 2;
export const MAX_APP_ID_LEN = 64;

/** 校验 App ID（小写 kebab-case，长度 2..64，排除 Windows 保留设备名首段）。 */
export function isAppId(s: string): boolean {
  if (s.length < MIN_APP_ID_LEN || s.length > MAX_APP_ID_LEN) return false;
  if (!APP_ID_RE.test(s)) return false;
  return !WINDOWS_RESERVED_SEGMENT.test(s.split('-')[0]);
}

/** 校验版本号格式。 */
export function isVersion(v: string): boolean {
  return VERSION_RE.test(v);
}

/**
 * 归一化授权对象：剥离前导 '@'；空或含 / \ tab 换行 返回 null（非法）。
 * 与 Go validGrantee 一致。
 */
export function normalizeGrantee(raw: string): string | null {
  const t = typeof raw === 'string' && raw.startsWith('@') ? raw.slice(1) : raw;
  if (!t || /[/\\\t\n]/.test(t)) return null;
  return t;
}

/**
 * 授权匹配条件（跨 grant 表通用：grantee_type/grantee 列名一致）：
 * (grantee_type='user' AND lower(grantee)=lower(username))
 *   OR (grantee_type='group' AND lower(grantee) IN lower(groups))
 * 组为空时只保留 user 分支（严格默认拒绝）。
 */
export function granteeMatch(username: string, groupNames: string[]): SQL {
  const userCond = and(
    eq(sql`grantee_type`, 'user'),
    eq(sql`lower(grantee)`, username.toLowerCase()),
  );
  const lowerGroups = groupNames.map((g) => g.toLowerCase());
  if (lowerGroups.length === 0) return userCond!;
  const groupCond = and(
    eq(sql`grantee_type`, 'group'),
    inArray(sql`lower(grantee)`, lowerGroups),
  );
  return or(userCond!, groupCond!)!;
}

/** 解析用户的部门名列表（user_groups join groups）。 */
export async function resolveUserGroupNames(
  db: Database,
  userId: number,
): Promise<string[]> {
  const rows = await db
    .select({ name: groups.name })
    .from(userGroups)
    .innerJoin(groups, eq(userGroups.groupId, groups.id))
    .where(eq(userGroups.userId, userId));
  return rows.map((r) => r.name);
}

/** 格式化时间（北京时间 YYYY-MM-DD HH:mm:ss，与 Go "2006-01-02 15:04:05" 口径）。 */
export function formatDateTime(d: Date): string {
  const t = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(
    t.getUTCHours(),
  )}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}
