import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { capabilityLocks, type App, type AppRelease } from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import { formatDateTime } from '../common/skills-shared';
import { resolveUserEffectiveGroups } from '../common/effective-groups';
import {
  CHANNEL_MARKET,
  CHANNEL_ORG,
  STATUS_APPROVED,
  accessibleAppIds,
  compareVersions,
  delivered,
  distributionOf,
  distributionStates,
  listApps,
  listReleasesByStatus,
  ownedBy,
  type Distribution,
} from '../common/apps-shared';

export interface CapabilityItem {
  kind: 'skill' | 'agent';
  source: 'market' | 'org';
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: string;
  status: string;
  reason?: string;
  quality?: string;
  official: boolean;
  downloads: number;
  calls: number;
  score: number;
  is_owner: boolean;
  delisted: boolean;
  versions: string[];
}

export interface ApprovalRow {
  kind: 'skill' | 'agent';
  name: string;
  version: string;
  display_name: string;
  description: string;
  author: string;
  owner: string;
  status: string;
  reason?: string;
  quality?: string;
  created_at: string;
  downloads: number;
  calls?: number;
  base_path: string;
  grants_base: string;
  preview_path: string;
  conflict: boolean;
  official: boolean;
  enabled: boolean;
}

type CapKind = 'skill' | 'agent';

/** 某 app 的最高 approved（未软删）版本；无则 null（Go currentRelease）。 */
function highestApproved(releases: AppRelease[], appId: string): AppRelease | null {
  let best: AppRelease | null = null;
  for (const r of releases) {
    if (r.appId !== appId || r.deletedAt || r.status !== STATUS_APPROVED) continue;
    if (!best || compareVersions(r.version, best.version) > 0) best = r;
  }
  return best;
}

/** 归属人视图判据：只有归属人自己（官方内容 owner 为空，不属于任何人）。 */
function isDelisted(d: Distribution): boolean {
  return d.exists && (!d.enabled || d.deleted);
}

@Injectable()
export class CapabilitiesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private adminFull(role: string): boolean {
    return role === 'super_admin' || role === 'auditor';
  }

  private item(
    kind: CapKind,
    source: 'market' | 'org',
    name: string,
    displayName: string,
    version: string,
    description: string,
    author: string,
    status: string,
    official: boolean,
    downloads: number,
    calls: number,
    isOwner: boolean,
    delisted: boolean,
    reason = '',
    quality = '',
  ): CapabilityItem {
    return {
      kind,
      source,
      name,
      display_name: displayName || name,
      version,
      description,
      author,
      status,
      ...(reason ? { reason } : {}),
      ...(quality ? { quality } : {}),
      official,
      downloads,
      calls,
      score: 0,
      is_owner: isOwner,
      delisted,
      versions: [],
    };
  }

  /**
   * 员工面能力中心聚合（apps 统一模型）。
   *
   * 三个分区（与 Go capabilities.listCapabilities 同口径）：
   *   market —— kind 对应 channel='market' 且已上架；admin 全量，否则 app_grants 授权；
   *   org    —— channel='org' 且已上架；admin 全量 approved，否则「归属人」或「approved + 授权」，
   *             该分区只展示 approved；
   *   own    —— 归属人的全部版本（任意状态、忽略下架；下架行 delisted=true）。
   */
  async list(
    query: { source?: string; type?: string },
    username: string,
    role: string,
    userId: number,
  ): Promise<CapabilityItem[]> {
    const src = query?.source ?? '';
    const includeMarket = src === '' || src === 'market';
    const includeOrg = src === '' || src === 'market' || src === 'org';
    const includeOwn = src === 'own' || src === 'local';
    const ft = this.parseType(query?.type);
    const admin = this.adminFull(role);
    const groups = admin ? [] : await resolveUserEffectiveGroups(this.db, userId);

    const wantSkills = ft.skills && (includeMarket || includeOrg || includeOwn);
    const wantAgents = ft.agents && (includeMarket || includeOrg || includeOwn);

    const [skillDists, agentDists, skillApps, agentApps] = await Promise.all([
      wantSkills ? distributionStates(this.db, 'skill') : new Map<string, Distribution>(),
      wantAgents ? distributionStates(this.db, 'agent') : new Map<string, Distribution>(),
      wantSkills ? listApps(this.db, 'skill') : Promise.resolve([] as App[]),
      wantAgents ? listApps(this.db, 'agent') : Promise.resolve([] as App[]),
    ]);

    // 一次取齐该 kind 的全部未软删版本（含任意状态）；市场展示版本 = 最高 approved。
    const [skillReleases, agentReleases] = await Promise.all([
      wantSkills ? listReleasesByStatus(this.db, 'skill') : Promise.resolve([] as AppRelease[]),
      wantAgents ? listReleasesByStatus(this.db, 'agent') : Promise.resolve([] as AppRelease[]),
    ]);

    const items: CapabilityItem[] = [];
    const skillById = new Map(skillApps.map((a) => [a.appId, a] as const));
    const agentById = new Map(agentApps.map((a) => [a.appId, a] as const));

    // ---------------------------------------------------------------- 市场技能
    if (includeMarket && ft.skills) {
      const allowed = admin
        ? null
        : new Set(await accessibleAppIds(this.db, 'skill', username, groups));
      for (const a of skillApps) {
        if (a.channel !== CHANNEL_MARKET || a.enabled !== 1 || a.deletedAt) continue;
        if (allowed && !allowed.has(a.appId)) continue;
        const r = highestApproved(skillReleases, a.appId);
        const d = distributionOf(skillDists, a.appId);
        items.push(
          this.item(
            'skill',
            'market',
            a.appId,
            a.title,
            r?.version ?? '',
            a.description || r?.description || '',
            a.owner,
            STATUS_APPROVED,
            a.official === 1,
            r?.downloads ?? 0,
            r?.calls ?? 0,
            ownedBy(d, username),
            false,
          ),
        );
      }
    }

    // -------------------------------------------------------------- 市场智能体
    if (includeMarket && ft.agents) {
      const allowed = admin
        ? null
        : new Set(await accessibleAppIds(this.db, 'agent', username, groups));
      for (const a of agentApps) {
        if (a.channel !== CHANNEL_MARKET || a.enabled !== 1 || a.deletedAt) continue;
        if (allowed && !allowed.has(a.appId)) continue;
        const r = highestApproved(agentReleases, a.appId);
        if (!r) continue; // 无 approved 版本的市场智能体不可见
        const d = distributionOf(agentDists, a.appId);
        items.push(
          this.item(
            'agent',
            'market',
            a.appId,
            a.title,
            r.version,
            a.description,
            a.owner,
            STATUS_APPROVED,
            a.official === 1,
            r.downloads,
            r.calls,
            ownedBy(d, username),
            false,
          ),
        );
      }
    }

    // -------------------------------------------------------- 组织共享技能（org）
    if (includeOrg && ft.skills) {
      const allowed = admin
        ? null
        : new Set(await accessibleAppIds(this.db, 'skill', username, groups));
      for (const r of skillReleases) {
        const a = skillById.get(r.appId);
        if (!a || a.channel !== CHANNEL_ORG || a.deletedAt) continue;
        const d = distributionOf(skillDists, r.appId);
        if (!delivered(d)) continue;
        const owner = ownedBy(d, username);
        if (!admin) {
          // 组织分区只展示 approved：归属人的 pending/rejected 归「我的」分区。
          if (r.status !== STATUS_APPROVED) continue;
          if (!owner && !allowed?.has(r.appId)) continue;
        } else if (r.status !== STATUS_APPROVED) {
          continue;
        }
        items.push(
          this.item(
            'skill',
            'org',
            r.appId,
            r.title,
            r.version,
            r.description,
            r.publisher || a.owner,
            r.status,
            a.official === 1,
            r.downloads,
            r.calls,
            owner,
            false,
            r.reason,
            r.quality,
          ),
        );
      }
    }

    // -------------------------------------------------------- 组织共享 Agent（org）
    if (includeOrg && ft.agents) {
      const allowed = admin
        ? null
        : new Set(await accessibleAppIds(this.db, 'agent', username, groups));
      for (const r of agentReleases) {
        const a = agentById.get(r.appId);
        if (!a || a.channel !== CHANNEL_ORG || a.deletedAt) continue;
        const d = distributionOf(agentDists, r.appId);
        if (!delivered(d)) continue;
        const owner = ownedBy(d, username);
        if (!admin) {
          if (r.status !== STATUS_APPROVED) continue;
          if (!owner && !allowed?.has(r.appId)) continue;
        } else if (r.status !== STATUS_APPROVED) {
          continue;
        }
        items.push(
          this.item(
            'agent',
            'org',
            r.appId,
            r.title,
            r.version,
            r.description,
            r.publisher || a.owner,
            r.status,
            a.official === 1,
            r.downloads,
            r.calls,
            owner,
            false,
            r.reason,
            r.quality,
          ),
        );
      }
    }

    // --------------------------------------------- 「我的」：归属人的全部版本
    if (includeOwn) {
      if (ft.skills) {
        // 组织渠道：任意状态、忽略上下架（下架只挡分发面）。
        for (const r of skillReleases) {
          const a = skillById.get(r.appId);
          if (!a || a.channel !== CHANNEL_ORG) continue;
          const d = distributionOf(skillDists, r.appId);
          if (!ownedBy(d, username)) continue;
          items.push(
            this.item(
              'skill',
              'org',
              r.appId,
              r.title,
              r.version,
              r.description,
              r.publisher || a.owner,
              r.status,
              a.official === 1,
              r.downloads,
              r.calls,
              true,
              isDelisted(d),
              r.reason,
              r.quality,
            ),
          );
        }
        // 市场渠道：仍可见，delisted=true。
        for (const a of skillApps) {
          if (a.channel !== CHANNEL_MARKET) continue;
          const d = distributionOf(skillDists, a.appId);
          if (!ownedBy(d, username)) continue;
          const r = highestApproved(skillReleases, a.appId);
          if (!r) continue;
          items.push(
            this.item(
              'skill',
              'market',
              a.appId,
              a.title,
              r.version,
              a.description,
              a.owner,
              STATUS_APPROVED,
              a.official === 1,
              r.downloads,
              r.calls,
              true,
              isDelisted(d),
            ),
          );
        }
      }
      if (ft.agents) {
        for (const r of agentReleases) {
          const a = agentById.get(r.appId);
          if (!a || a.channel !== CHANNEL_ORG) continue;
          const d = distributionOf(agentDists, r.appId);
          if (!ownedBy(d, username)) continue;
          items.push(
            this.item(
              'agent',
              'org',
              r.appId,
              r.title,
              r.version,
              r.description,
              r.publisher || a.owner,
              r.status,
              a.official === 1,
              r.downloads,
              r.calls,
              true,
              isDelisted(d),
              r.reason,
              r.quality,
            ),
          );
        }
        for (const a of agentApps) {
          if (a.channel !== CHANNEL_MARKET) continue;
          const d = distributionOf(agentDists, a.appId);
          if (!ownedBy(d, username)) continue;
          const r = highestApproved(agentReleases, a.appId);
          if (!r) continue;
          items.push(
            this.item(
              'agent',
              'market',
              a.appId,
              a.title,
              r.version,
              a.description,
              a.owner,
              STATUS_APPROVED,
              a.official === 1,
              r.downloads,
              r.calls,
              true,
              isDelisted(d),
            ),
          );
        }
      }
    }

    const merged = this.mergeVersions(items);
    const folded = src === 'market' ? this.mergeMarketFirst(merged) : merged;
    return src !== 'own' && src !== 'local' ? this.sortCatalog(this.scoreItems(folded)) : folded;
  }

  private parseType(t: string | undefined): { skills: boolean; agents: boolean } {
    switch (t) {
      case 'skill':
        return { skills: true, agents: false };
      case 'agent':
        return { skills: false, agents: true };
      case '':
      case undefined:
      case 'all':
        return { skills: true, agents: true };
      default: {
        const parts = t.split(',').filter((p) => p !== '');
        return { skills: parts.includes('skill'), agents: parts.includes('agent') };
      }
    }
  }

  /** 同名(kind+name)多版本归并：最高 approved 为展示行，versions 全部 approved 升序。 */
  private mergeVersions(items: CapabilityItem[]): CapabilityItem[] {
    const byKey = new Map<string, CapabilityItem[]>();
    for (const it of items) {
      const k = `${it.kind}\u0000${it.name}`;
      const arr = byKey.get(k) ?? [];
      arr.push(it);
      byKey.set(k, arr);
    }
    const out: CapabilityItem[] = [];
    for (const arr of byKey.values()) {
      const approved = arr.filter((i) => i.status === STATUS_APPROVED);
      const display =
        approved.length > 0
          ? approved.reduce((best, i) =>
              compareVersions(i.version, best.version) > 0 ? i : best,
            )
          : arr[0];
      const versions = approved
        .map((i) => i.version)
        .sort(compareVersions)
        .filter((v, i, a) => a.indexOf(v) === i);
      if (display.status === STATUS_APPROVED && versions.length === 0) {
        versions.push(display.version);
      }
      const quality = arr.find((i) => i.quality === 'featured')?.quality ?? '';
      const isOwner = arr.some((i) => i.is_owner);
      out.push({ ...display, versions, quality, is_owner: isOwner });
    }
    return out;
  }

  /** ?source=market 合并：同名(kind+name) market 优先，org 折叠进 versions。 */
  private mergeMarketFirst(items: CapabilityItem[]): CapabilityItem[] {
    const byKey = new Map<string, CapabilityItem>();
    const order: string[] = [];
    for (const it of items) {
      const k = `${it.kind}\u0000${it.name}`;
      const cur = byKey.get(k);
      if (!cur) {
        byKey.set(k, it);
        order.push(k);
        continue;
      }
      const versions = Array.from(
        new Set([...cur.versions, cur.version, ...it.versions, it.version]),
      ).sort(compareVersions);
      if (cur.source === 'market') {
        byKey.set(k, { ...cur, versions });
      } else if (it.source === 'market') {
        byKey.set(k, { ...it, versions });
      } else {
        byKey.set(k, { ...cur, versions });
      }
    }
    return order.map((k) => byKey.get(k)!);
  }

  private scoreItems(items: CapabilityItem[]): CapabilityItem[] {
    for (const it of items) it.score = it.calls * 3 + it.downloads;
    return items;
  }

  private sortCatalog(items: CapabilityItem[]): CapabilityItem[] {
    return [...items].sort((a, b) => {
      if (a.official !== b.official) return a.official ? -1 : 1;
      const af = a.quality === 'featured';
      const bf = b.quality === 'featured';
      if (af !== bf) return af ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }

  // ------------------------------------------------------------ admin approvals

  /**
   * 管理端审核队列：组织渠道（channel='org'）的版本按状态汇总，
   * 技能与智能体分别来自 app_releases(kind=...)。
   * DTO 形状（含 base_path / grants_base / preview_path）保持不变：
   * 审核动作仍落在 shared-skills / agent-presets 端点，经 setReleaseStatusForReview 裁决。
   */
  async approvals(query: { status?: string; type?: string }): Promise<ApprovalRow[]> {
    const status = query?.status || 'pending';
    const ft = this.parseType(query?.type);
    const statusFilter = status === 'all' ? undefined : status;
    const out: ApprovalRow[] = [];

    if (ft.skills) {
      const [apps, dists, rows] = await Promise.all([
        listApps(this.db, 'skill', CHANNEL_ORG),
        distributionStates(this.db, 'skill'),
        listReleasesByStatus(this.db, 'skill', statusFilter),
      ]);
      const byId = new Map(apps.map((a) => [a.appId, a] as const));
      for (const r of rows) {
        const a = byId.get(r.appId);
        if (!a) continue;
        const d = distributionOf(dists, r.appId);
        out.push({
          kind: 'skill',
          name: r.appId,
          version: r.version,
          display_name: r.title || a.title || r.appId,
          description: r.description,
          author: r.publisher,
          owner: a.owner,
          status: r.status,
          reason: r.reason,
          quality: r.quality,
          created_at: formatDateTime(r.createdAt),
          downloads: r.downloads,
          calls: r.calls,
          base_path: `/api/server/admin/shared-skills/${r.appId}/${r.version}`,
          grants_base: `/api/server/admin/shared-skills/${r.appId}`,
          preview_path: `/api/server/admin/shared-skills/${r.appId}/${r.version}/preview`,
          conflict: false,
          official: a.official === 1,
          enabled: delivered(d),
        });
      }
    }

    if (ft.agents) {
      const [apps, dists, rows] = await Promise.all([
        listApps(this.db, 'agent', CHANNEL_ORG),
        distributionStates(this.db, 'agent'),
        listReleasesByStatus(this.db, 'agent', statusFilter),
      ]);
      const byId = new Map(apps.map((a) => [a.appId, a] as const));
      for (const r of rows) {
        const a = byId.get(r.appId);
        if (!a) continue;
        const d = distributionOf(dists, r.appId);
        out.push({
          kind: 'agent',
          name: r.appId,
          version: r.version,
          display_name: r.title || a.title || r.appId,
          description: r.description,
          author: r.publisher,
          owner: a.owner,
          status: r.status,
          reason: r.reason,
          quality: r.quality,
          created_at: formatDateTime(r.createdAt),
          downloads: r.downloads,
          base_path: `/api/server/admin/agent-presets/${r.appId}/${r.version}`,
          grants_base: `/api/server/admin/agent-presets/${r.appId}`,
          preview_path: `/api/server/admin/agent-presets/${r.appId}/${r.version}/preview`,
          conflict: false,
          official: a.official === 1,
          enabled: delivered(d),
        });
      }
    }

    return out;
  }

  // ------------------------------------------------------------ capability locks

  async listLocks(): Promise<
    { kind: string; name: string; reason: string; locked_by: string; created_at: string }[]
  > {
    const rows = await this.db
      .select()
      .from(capabilityLocks)
      .orderBy(capabilityLocks.createdAt);
    return rows.map((l) => ({
      kind: l.kind,
      name: l.name,
      reason: l.reason,
      locked_by: l.lockedBy,
      created_at: formatDateTime(l.createdAt),
    }));
  }

  async lock(
    kind: string,
    name: string,
    reason: string,
    username: string,
  ): Promise<void> {
    if (kind !== 'skill' && kind !== 'agent') {
      throw new ApiError('VALIDATION', '类型不合法(skill|agent)', 400);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      throw new ApiError('INVALID_APP_ID', '名称不合法');
    }
    if (reason.length > 500) {
      throw new ApiError('VALIDATION', '理由过长(上限 500 字)', 400);
    }
    await this.db
      .insert(capabilityLocks)
      .values({ kind, name, reason, lockedBy: username })
      .onConflictDoUpdate({
        target: [capabilityLocks.kind, capabilityLocks.name],
        set: { reason, lockedBy: username, createdAt: new Date() },
      });
  }

  async unlock(kind: string, name: string): Promise<void> {
    if (kind !== 'skill' && kind !== 'agent') {
      throw new ApiError('VALIDATION', '类型不合法(skill|agent)', 400);
    }
    const [row] = await this.db
      .select()
      .from(capabilityLocks)
      .where(and(eq(capabilityLocks.kind, kind), eq(capabilityLocks.name, name)))
      .limit(1);
    if (!row) throw new ApiError('NOT_FOUND', '该名称未被锁定');
    await this.db
      .delete(capabilityLocks)
      .where(and(eq(capabilityLocks.kind, kind), eq(capabilityLocks.name, name)));
  }
}
