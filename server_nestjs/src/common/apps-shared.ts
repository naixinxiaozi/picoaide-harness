import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/database.module';
import {
  appGrants,
  appReleases,
  apps,
  type App,
  type AppKind,
  type AppRelease,
  type GranteeType,
  type ReviewStatus,
} from '../db/schema';
import { normalizeGrantee } from './skills-shared';

/**
 * 统一应用模型数据访问层（apps + app_releases + app_grants）。
 *
 * 语义权威：server/internal/serverstore/{apps,skills,shared_skills,
 * agent_presets,grants,distribution}.go。所有技能/智能体域的业务服务都必须经
 * 这里读写，禁止各自拼 SQL，否则会再次出现「同一事实三处判据」的历史缺陷。
 */

export const CHANNEL_MARKET = 'market' as const;
export const CHANNEL_ORG = 'org' as const;

export const STATUS_PENDING = 'pending' as const;
export const STATUS_APPROVED = 'approved' as const;
export const STATUS_REJECTED = 'rejected' as const;

/** 版本比较（semver 数字段 + 可选 prerelease），返回 <0 / 0 / >0。 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const [core, pre = ''] = v.split('-', 2);
    const nums = core.split('.').map((x) => Number.parseInt(x, 10) || 0);
    return { nums, pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  // 无 prerelease 的版本更高（1.0.0 > 1.0.0-rc1）。
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** 标签列（库内 JSON 字符串）→ 数组。 */
export function parseTags(raw: string): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.map((t) => String(t)) : [];
  } catch {
    return [];
  }
}

/** 数组 → 标签列（JSON 字符串）。 */
export function encodeTags(tags: string[]): string {
  return tags.length ? JSON.stringify(tags) : '';
}

// ---------------------------------------------------------------- apps（身份）

export async function getApp(
  db: Database,
  kind: AppKind,
  appId: string,
): Promise<App | null> {
  const [row] = await db
    .select()
    .from(apps)
    .where(and(eq(apps.kind, kind), eq(apps.appId, appId)))
    .limit(1);
  return row ?? null;
}

export async function listApps(
  db: Database,
  kind: AppKind,
  channel?: string,
): Promise<App[]> {
  const cond = channel
    ? and(eq(apps.kind, kind), eq(apps.channel, channel as never))
    : eq(apps.kind, kind);
  return db.select().from(apps).where(cond).orderBy(apps.kind, apps.appId);
}

/** App 行是否存在且处于上架态（行不存在返回 false）。 */
export async function appEnabled(
  db: Database,
  kind: AppKind,
  appId: string,
): Promise<boolean> {
  const app = await getApp(db, kind, appId);
  return app ? app.enabled === 1 : false;
}

export async function enabledAppIds(
  db: Database,
  kind: AppKind,
): Promise<string[]> {
  const rows = await db
    .select({ appId: apps.appId })
    .from(apps)
    .where(and(eq(apps.kind, kind), eq(apps.enabled, 1)));
  return rows.map((r) => r.appId);
}

/**
 * Upsert App 身份。官方行的 owner 恒为空（官方内容不属于任何人）；
 * 已存在的非官方行保留原 owner（发布权转移只能走归属转移端点）。
 */
export async function upsertApp(
  db: Database,
  app: {
    kind: AppKind;
    appId: string;
    title: string;
    description?: string;
    owner?: string;
    channel: string;
    enabled?: number;
  },
): Promise<void> {
  await db
    .insert(apps)
    .values({
      kind: app.kind,
      appId: app.appId,
      title: app.title,
      description: app.description ?? '',
      owner: app.owner ?? '',
      channel: app.channel as never,
      enabled: app.enabled ?? 1,
    })
    .onConflictDoUpdate({
      target: [apps.kind, apps.appId],
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        owner: sql`CASE WHEN ${apps.official} = 1 THEN '' ELSE COALESCE(NULLIF(${apps.owner}, ''), excluded.owner) END`,
        updatedAt: sql`now()`,
      },
    });
}

export async function setAppTitle(
  db: Database,
  kind: AppKind,
  appId: string,
  title: string,
): Promise<boolean> {
  const res = await db
    .update(apps)
    .set({ title, updatedAt: new Date() })
    .where(and(eq(apps.kind, kind), eq(apps.appId, appId)))
    .returning({ appId: apps.appId });
  return res.length > 0;
}

export async function setAppEnabled(
  db: Database,
  kind: AppKind,
  appId: string,
  enabled: boolean,
): Promise<boolean> {
  const res = await db
    .update(apps)
    .set({ enabled: enabled ? 1 : 0, updatedAt: new Date() })
    .where(and(eq(apps.kind, kind), eq(apps.appId, appId)))
    .returning({ appId: apps.appId });
  return res.length > 0;
}

export async function setAppOwner(
  db: Database,
  kind: AppKind,
  appId: string,
  owner: string,
): Promise<boolean> {
  const res = await db
    .update(apps)
    .set({ owner, updatedAt: new Date() })
    .where(and(eq(apps.kind, kind), eq(apps.appId, appId)))
    .returning({ appId: apps.appId });
  return res.length > 0;
}

export async function setAppOfficial(
  db: Database,
  kind: AppKind,
  appId: string,
  official: boolean,
  owner: string,
): Promise<boolean> {
  const res = await db
    .update(apps)
    .set({ official: official ? 1 : 0, owner, updatedAt: new Date() })
    .where(and(eq(apps.kind, kind), eq(apps.appId, appId)))
    .returning({ appId: apps.appId });
  return res.length > 0;
}

// ------------------------------------------------------------- releases（版本）

export async function createRelease(
  db: Database,
  release: {
    kind: AppKind;
    appId: string;
    version: string;
    title?: string;
    description?: string;
    changelog?: string;
    category?: string;
    tags?: string[];
    author?: string;
    publisher?: string;
    checksum?: string;
    archive?: Buffer | null;
    status?: ReviewStatus;
    reason?: string;
    quality?: string;
    configJson?: string;
  },
): Promise<number> {
  const [row] = await db
    .insert(appReleases)
    .values({
      kind: release.kind,
      appId: release.appId,
      version: release.version,
      title: release.title ?? '',
      description: release.description ?? '',
      changelog: release.changelog ?? '',
      category: release.category ?? '',
      tags: encodeTags(release.tags ?? []),
      author: release.author ?? '',
      publisher: release.publisher ?? '',
      checksum: release.checksum ?? '',
      size: release.archive ? release.archive.length : 0,
      archive: release.archive ?? null,
      status: release.status ?? STATUS_PENDING,
      reason: release.reason ?? '',
      quality: release.quality ?? '',
      configJson: release.configJson ?? '',
    })
    .returning({ id: appReleases.id });
  return row!.id;
}

export async function getRelease(
  db: Database,
  kind: AppKind,
  appId: string,
  version: string,
): Promise<AppRelease | null> {
  const [row] = await db
    .select()
    .from(appReleases)
    .where(
      and(
        eq(appReleases.kind, kind),
        eq(appReleases.appId, appId),
        eq(appReleases.version, version),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 一个 App 的全部版本（含被拒与软删；顺序与 Go ListReleases 一致：created_at）。 */
export async function listReleases(
  db: Database,
  kind: AppKind,
  appId: string,
): Promise<AppRelease[]> {
  return db
    .select()
    .from(appReleases)
    .where(and(eq(appReleases.kind, kind), eq(appReleases.appId, appId)))
    .orderBy(asc(appReleases.createdAt), asc(appReleases.id));
}

/** 按状态取某 kind 的**未软删**版本（管理端清单）。 */
export async function listReleasesByStatus(
  db: Database,
  kind: AppKind,
  status?: string,
): Promise<AppRelease[]> {
  const cond = status
    ? and(
        eq(appReleases.kind, kind),
        eq(appReleases.status, status as ReviewStatus),
        sql`${appReleases.deletedAt} IS NULL`,
      )
    : and(eq(appReleases.kind, kind), sql`${appReleases.deletedAt} IS NULL`);
  return db
    .select()
    .from(appReleases)
    .where(cond)
    .orderBy(desc(appReleases.createdAt), desc(appReleases.id));
}

/**
 * 展示版本：最高 approved 且未软删（Go currentRelease）。技能与市场智能体共用。
 * 返回不含 archive 的列表行也可以；需要字节时再 getRelease。
 */
export async function currentRelease(
  db: Database,
  kind: AppKind,
  appId: string,
): Promise<AppRelease | null> {
  const list = await listReleases(db, kind, appId);
  let best: AppRelease | null = null;
  for (const r of list) {
    if (r.deletedAt || r.status !== STATUS_APPROVED) continue;
    if (!best || compareVersions(r.version, best.version) > 0) best = r;
  }
  return best;
}

/**
 * 审核裁决（Go SetReleaseStatusForReview）。
 * approved：要求未软删、归档存在（或上次不是 rejected）、App 行存在且未软删；
 * rejected：只允许非 approved 行，同一条 UPDATE 里清空归档字节。
 */
export async function setReleaseStatusForReview(
  db: Database,
  kind: AppKind,
  appId: string,
  version: string,
  next: 'approved' | 'rejected',
  reason = '',
): Promise<'ok' | 'not_found' | 'archive_cleared' | 'approved_not_rejectable'> {
  const release = await getRelease(db, kind, appId, version);
  if (!release || release.deletedAt) return 'not_found';

  if (next === 'approved') {
    const app = await getApp(db, kind, appId);
    if (!app || app.deletedAt) return 'not_found';
    if (!release.archive && release.status === STATUS_REJECTED) {
      return 'archive_cleared';
    }
    await db
      .update(appReleases)
      .set({ status: STATUS_APPROVED, reason: '', updatedAt: new Date() })
      .where(
        and(
          eq(appReleases.kind, kind),
          eq(appReleases.appId, appId),
          eq(appReleases.version, version),
          sql`${appReleases.deletedAt} IS NULL`,
        ),
      );
    return 'ok';
  }

  if (release.status === STATUS_APPROVED) return 'approved_not_rejectable';
  await db
    .update(appReleases)
    .set({
      status: STATUS_REJECTED,
      reason,
      quality: '',
      archive: null,
      size: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appReleases.kind, kind),
        eq(appReleases.appId, appId),
        eq(appReleases.version, version),
        sql`${appReleases.status} <> ${STATUS_APPROVED}`,
      ),
    );
  return 'ok';
}

/** 质量标记（仅 approved 版本生效）。 */
export async function setReleaseQuality(
  db: Database,
  kind: AppKind,
  appId: string,
  version: string,
  quality: string,
): Promise<boolean> {
  const res = await db
    .update(appReleases)
    .set({ quality, updatedAt: new Date() })
    .where(
      and(
        eq(appReleases.kind, kind),
        eq(appReleases.appId, appId),
        eq(appReleases.version, version),
        eq(appReleases.status, STATUS_APPROVED),
      ),
    )
    .returning({ id: appReleases.id });
  return res.length > 0;
}

/** 软删版本：版本号永久占位，归档字节释放。 */
export async function softDeleteRelease(
  db: Database,
  kind: AppKind,
  appId: string,
  version: string,
): Promise<boolean> {
  const res = await db
    .update(appReleases)
    .set({ deletedAt: new Date(), archive: null, size: 0 })
    .where(
      and(
        eq(appReleases.kind, kind),
        eq(appReleases.appId, appId),
        eq(appReleases.version, version),
        sql`${appReleases.deletedAt} IS NULL`,
      ),
    )
    .returning({ id: appReleases.id });
  return res.length > 0;
}

export async function incrementReleaseDownload(
  db: Database,
  kind: AppKind,
  appId: string,
  version: string,
): Promise<boolean> {
  const res = await db
    .update(appReleases)
    .set({ downloads: sql`${appReleases.downloads} + 1` })
    .where(
      and(
        eq(appReleases.kind, kind),
        eq(appReleases.appId, appId),
        eq(appReleases.version, version),
      ),
    )
    .returning({ id: appReleases.id });
  return res.length > 0;
}

export async function incrementReleaseCall(
  db: Database,
  kind: AppKind,
  appId: string,
  version: string,
): Promise<boolean> {
  const res = await db
    .update(appReleases)
    .set({ calls: sql`${appReleases.calls} + 1` })
    .where(
      and(
        eq(appReleases.kind, kind),
        eq(appReleases.appId, appId),
        eq(appReleases.version, version),
      ),
    )
    .returning({ id: appReleases.id });
  return res.length > 0;
}

/** 覆盖某版本归档（数据修复/播种用；发布路径不调用）。 */
export async function setReleaseArchive(
  db: Database,
  kind: AppKind,
  appId: string,
  version: string,
  archive: Buffer | null,
): Promise<boolean> {
  const res = await db
    .update(appReleases)
    .set({
      archive,
      size: archive ? archive.length : 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appReleases.kind, kind),
        eq(appReleases.appId, appId),
        eq(appReleases.version, version),
      ),
    )
    .returning({ id: appReleases.id });
  return res.length > 0;
}

// ------------------------------------------------------- distribution（分发面）

export interface Distribution {
  appId: string;
  owner: string;
  enabled: boolean;
  exists: boolean;
  deleted: boolean;
}

/** 分发面判据：存在、未删、上架（Go Distribution.Delivered）。 */
export function delivered(d: Distribution): boolean {
  return d.exists && d.enabled && !d.deleted;
}

/** 写入面判据：App 行不存在（首版发布）或处于上架态（下架期间冻结）。 */
export function writable(d: Distribution): boolean {
  return !d.exists || (d.enabled && !d.deleted);
}

/** 归属判据：空 owner 不属于任何人（官方内容与历史行）。 */
export function ownedBy(d: Distribution, viewer: string): boolean {
  return !!d.owner && !!viewer && d.owner === viewer;
}

export async function distributionStates(
  db: Database,
  kind: AppKind,
): Promise<Map<string, Distribution>> {
  const rows = await db
    .select({
      appId: apps.appId,
      owner: apps.owner,
      enabled: apps.enabled,
      deletedAt: apps.deletedAt,
    })
    .from(apps)
    .where(eq(apps.kind, kind));
  const out = new Map<string, Distribution>();
  for (const r of rows) {
    out.set(r.appId, {
      appId: r.appId,
      owner: r.owner,
      enabled: r.enabled === 1,
      exists: true,
      deleted: !!r.deletedAt,
    });
  }
  return out;
}

export function distributionOf(
  states: Map<string, Distribution>,
  appId: string,
): Distribution {
  return (
    states.get(appId) ?? {
      appId,
      owner: '',
      enabled: false,
      exists: false,
      deleted: false,
    }
  );
}

export async function appDistribution(
  db: Database,
  kind: AppKind,
  appId: string,
): Promise<Distribution> {
  const app = await getApp(db, kind, appId);
  if (!app) {
    return { appId, owner: '', enabled: false, exists: false, deleted: false };
  }
  return {
    appId,
    owner: app.owner,
    enabled: app.enabled === 1,
    exists: true,
    deleted: !!app.deletedAt,
  };
}

// ------------------------------------------------------------------- grants

export async function grantApp(
  db: Database,
  kind: AppKind,
  appId: string,
  grantee: string,
  granteeType: GranteeType,
): Promise<boolean> {
  const g = normalizeGrantee(grantee);
  if (!g) return false;
  await db
    .insert(appGrants)
    .values({ kind, appId, granteeType, grantee: g })
    .onConflictDoNothing();
  return true;
}

export async function revokeApp(
  db: Database,
  kind: AppKind,
  appId: string,
  grantee: string,
  granteeType: GranteeType,
): Promise<boolean> {
  const g = normalizeGrantee(grantee);
  if (!g) return false;
  await db
    .delete(appGrants)
    .where(
      and(
        eq(appGrants.kind, kind),
        eq(appGrants.appId, appId),
        eq(appGrants.granteeType, granteeType),
        eq(appGrants.grantee, g),
      ),
    );
  return true;
}

export async function listAppGrants(
  db: Database,
  kind: AppKind,
  appId: string,
): Promise<{ grantee_type: GranteeType; grantee: string }[]> {
  const rows = await db
    .select({
      granteeType: appGrants.granteeType,
      grantee: appGrants.grantee,
    })
    .from(appGrants)
    .where(and(eq(appGrants.kind, kind), eq(appGrants.appId, appId)))
    .orderBy(asc(appGrants.granteeType), asc(appGrants.grantee));
  return rows.map((r) => ({ grantee_type: r.granteeType, grantee: r.grantee }));
}

export async function deleteAppGrants(
  db: Database,
  kind: AppKind,
  appId: string,
): Promise<void> {
  await db
    .delete(appGrants)
    .where(and(eq(appGrants.kind, kind), eq(appGrants.appId, appId)));
}

/** 删除某 grantee 的全部授权（用户/部门删除级联用）。 */
export async function deleteGrantsForGrantee(
  db: Database,
  granteeType: GranteeType,
  grantee: string,
): Promise<void> {
  await db
    .delete(appGrants)
    .where(
      and(
        eq(appGrants.granteeType, granteeType),
        sql`lower(${appGrants.grantee}) = lower(${grantee})`,
      ),
    );
}

/**
 * 整体替换部门授权（用户授权不动），事务内逐个校验部门存在。
 * 与 Go ReplaceSharedGroups 同语义。
 */
export async function replaceGroupGrants(
  db: Database,
  kind: AppKind,
  appId: string,
  groupNames: string[],
  groupExists: (name: string) => Promise<boolean>,
): Promise<'ok' | 'invalid' | 'not_found'> {
  const seen = new Set<string>();
  for (const g of groupNames) {
    if (!g || seen.has(g)) return 'invalid';
    seen.add(g);
    if (!(await groupExists(g))) return 'not_found';
  }
  await db
    .delete(appGrants)
    .where(
      and(
        eq(appGrants.kind, kind),
        eq(appGrants.appId, appId),
        eq(appGrants.granteeType, 'group'),
      ),
    );
  for (const g of groupNames) {
    await db
      .insert(appGrants)
      .values({ kind, appId, granteeType: 'group', grantee: g })
      .onConflictDoNothing();
  }
  return 'ok';
}

/**
 * 可见 App 集合（严格默认拒绝）：
 * 直接授权给该用户，或授权给其任一部门（大小写不敏感）。
 */
export async function accessibleAppIds(
  db: Database,
  kind: AppKind,
  username: string,
  groupNames: string[],
): Promise<string[]> {
  const lowerGroups = groupNames.map((g) => g.toLowerCase());
  const clauses = [
    and(
      eq(appGrants.granteeType, 'user'),
      sql`lower(${appGrants.grantee}) = ${username.toLowerCase()}`,
    )!,
  ];
  if (lowerGroups.length > 0) {
    clauses.push(
      and(
        eq(appGrants.granteeType, 'group'),
        inArray(sql`lower(${appGrants.grantee})`, lowerGroups),
      )!,
    );
  }
  const rows = await db
    .selectDistinct({ appId: appGrants.appId })
    .from(appGrants)
    .where(and(eq(appGrants.kind, kind), sql`(${sql.join(clauses, sql` OR `)})`));
  return rows.map((r) => r.appId);
}
