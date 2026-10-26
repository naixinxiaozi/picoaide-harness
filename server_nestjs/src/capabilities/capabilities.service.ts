import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import {
  agentPresetGrants,
  agentPresets,
  capabilityLocks,
  sharedSkillGrants,
  sharedSkills,
  skillGrants,
  skills,
  type AgentPreset,
  type SharedSkill,
} from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import {
  formatDateTime,
  granteeMatch,
  resolveUserGroupNames,
} from '../common/skills-shared';

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

/** 数值感知的 semver 比较：a<b → -1，a==b → 0，a>b → 1。 */
function compareSemVer(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    const nx = Number(x);
    const ny = Number(y);
    const xNum = x !== '' && !Number.isNaN(nx);
    const yNum = y !== '' && !Number.isNaN(ny);
    if (xNum && yNum) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

@Injectable()
export class CapabilitiesService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private adminFull(role: string): boolean {
    return role === 'super_admin' || role === 'auditor';
  }

  private item(
    kind: 'skill' | 'agent',
    source: 'market' | 'org',
    name: string,
    displayName: string,
    version: string,
    description: string,
    author: string,
    status: string,
    isOwner: boolean,
    delisted: boolean,
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
      official: false,
      downloads: 0,
      calls: 0,
      score: 0,
      is_owner: isOwner,
      delisted,
      versions: [],
    };
  }

  /** 员工面能力中心聚合（三源合并）。 */
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
    const groups = await resolveUserGroupNames(this.db, userId);

    const items: CapabilityItem[] = [];

    // 1) 市场技能（授权制）。
    if (includeMarket && ft.skills) {
      const rows = await this.db
        .select()
        .from(skills)
        .where(eq(skills.enabled, 1))
        .orderBy(skills.name);
      let grantedSet = new Set<string>();
      if (!admin) {
        const granted = await this.db
          .selectDistinct({ name: skillGrants.skillName })
          .from(skillGrants)
          .where(granteeMatch(username, groups));
        grantedSet = new Set(granted.map((g) => g.name));
      }
      for (const s of rows) {
        if (!admin && !grantedSet.has(s.name)) continue;
        items.push(
          this.item(
            'skill',
            'market',
            s.name,
            s.displayName,
            s.version,
            s.description,
            s.author,
            'approved',
            s.author === username,
            false,
          ),
        );
      }
    }

    // 2) 组织·共享技能（审核 + 授权）。
    if (includeOrg && ft.skills) {
      const rows = await this.db
        .select()
        .from(sharedSkills)
        .orderBy(sharedSkills.name, sharedSkills.version);
      let grantedSet = new Set<string>();
      if (!admin) {
        const granted = await this.db
          .selectDistinct({ name: sharedSkillGrants.skillName })
          .from(sharedSkillGrants)
          .where(granteeMatch(username, groups));
        grantedSet = new Set(granted.map((g) => g.name));
      }
      for (const s of rows) {
        const visible = admin
          ? s.status === 'approved'
          : s.author === username || (s.status === 'approved' && grantedSet.has(s.name));
        if (!visible) continue;
        // 组织分区只展示 approved（作者 own 的 pending/rejected 由「我的」分区展示）。
        if (s.status !== 'approved') continue;
        items.push(
          this.item(
            'skill',
            'org',
            s.name,
            s.displayName,
            s.version,
            s.description,
            s.author,
            s.status,
            s.author === username,
            false,
          ),
        );
      }
    }

    // 3) 组织·共享 Agent（审核 + 授权）。市场智能体与共享预设共用 agentPresets
    // 表且无 channel 列，此处统一按 org 呈现（schema 局限，见报告）。
    if (includeOrg && ft.agents) {
      const rows = await this.db
        .select()
        .from(agentPresets)
        .orderBy(agentPresets.name, agentPresets.version);
      let grantedSet = new Set<string>();
      if (!admin) {
        const granted = await this.db
          .selectDistinct({ name: agentPresetGrants.presetName })
          .from(agentPresetGrants)
          .where(granteeMatch(username, groups));
        grantedSet = new Set(granted.map((g) => g.name));
      }
      for (const p of rows) {
        const visible = admin
          ? p.status === 'approved'
          : p.author === username || (p.status === 'approved' && grantedSet.has(p.name));
        if (!visible) continue;
        if (p.status !== 'approved') continue;
        items.push(
          this.item(
            'agent',
            'org',
            p.name,
            p.displayName,
            p.version,
            p.description,
            p.author,
            p.status,
            p.author === username,
            false,
          ),
        );
      }
    }

    // 4) 「我的」分区：归属人自己的行（任意状态 + 下架标记）。
    if (includeOwn) {
      if (ft.skills) {
        const owned = await this.db
          .select()
          .from(sharedSkills)
          .where(eq(sharedSkills.author, username))
          .orderBy(sharedSkills.name, sharedSkills.version);
        for (const s of owned) {
          items.push(
            this.item(
              'skill',
              'org',
              s.name,
              s.displayName,
              s.version,
              s.description,
              s.author,
              s.status,
              true,
              false,
            ),
          );
        }
        // 市场技能的归属行（下架仍可见，delisted=true）。
        const marketOwned = await this.db
          .select()
          .from(skills)
          .where(eq(skills.author, username))
          .orderBy(skills.name);
        for (const s of marketOwned) {
          items.push(
            this.item(
              'skill',
              'market',
              s.name,
              s.displayName,
              s.version,
              s.description,
              s.author,
              'approved',
              true,
              s.enabled !== 1,
            ),
          );
        }
      }
      if (ft.agents) {
        const owned = await this.db
          .select()
          .from(agentPresets)
          .where(eq(agentPresets.author, username))
          .orderBy(agentPresets.name, agentPresets.version);
        for (const p of owned) {
          items.push(
            this.item(
              'agent',
              'org',
              p.name,
              p.displayName,
              p.version,
              p.description,
              p.author,
              p.status,
              true,
              false,
            ),
          );
        }
      }
    }

    const merged = this.mergeVersions(items);
    const folded = src === 'market' ? this.mergeMarketFirst(merged) : merged;
    const finalItems =
      src !== 'own' && src !== 'local' ? this.sortCatalog(this.scoreItems(folded)) : folded;
    return finalItems;
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
      const approved = arr.filter((i) => i.status === 'approved');
      const display =
        approved.length > 0
          ? approved.reduce((best, i) =>
              compareSemVer(i.version, best.version) > 0 ? i : best,
            )
          : arr[0];
      const versions = approved
        .map((i) => i.version)
        .sort(compareSemVer)
        .filter((v, i, a) => a.indexOf(v) === i);
      if (display.status === 'approved' && versions.length === 0) {
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
      ).sort(compareSemVer);
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

  async approvals(query: {
    status?: string;
    type?: string;
  }): Promise<ApprovalRow[]> {
    const status = query?.status || 'pending';
    const ft = this.parseType(query?.type);
    const out: ApprovalRow[] = [];
    const statusFilter = status === 'all' ? undefined : status;

    if (ft.skills) {
      const rows = await this.db
        .select()
        .from(sharedSkills)
        .where(
          statusFilter
            ? eq(sharedSkills.status, statusFilter as SharedSkill['status'])
            : undefined,
        )
        .orderBy(sharedSkills.name, sharedSkills.version);
      for (const s of rows) {
        out.push({
          kind: 'skill',
          name: s.name,
          version: s.version,
          display_name: s.displayName,
          description: s.description,
          author: s.author,
          owner: s.author,
          status: s.status,
          reason: s.reason,
          quality: '',
          created_at: formatDateTime(s.createdAt),
          downloads: 0,
          calls: 0,
          base_path: `/api/server/admin/shared-skills/${s.name}/${s.version}`,
          grants_base: `/api/server/admin/shared-skills/${s.name}`,
          preview_path: `/api/server/admin/shared-skills/${s.name}/${s.version}/preview`,
          conflict: false,
          official: false,
          enabled: true,
        });
      }
    }

    if (ft.agents) {
      const rows = await this.db
        .select()
        .from(agentPresets)
        .where(
          statusFilter
            ? eq(agentPresets.status, statusFilter as AgentPreset['status'])
            : undefined,
        )
        .orderBy(agentPresets.name, agentPresets.version);
      for (const p of rows) {
        out.push({
          kind: 'agent',
          name: p.name,
          version: p.version,
          display_name: p.displayName,
          description: p.description,
          author: p.author,
          owner: p.author,
          status: p.status,
          reason: p.reason,
          quality: '',
          created_at: formatDateTime(p.createdAt),
          downloads: 0,
          base_path: `/api/server/admin/agent-presets/${p.name}/${p.version}`,
          grants_base: `/api/server/admin/agent-presets/${p.name}`,
          preview_path: `/api/server/admin/agent-presets/${p.name}/${p.version}/preview`,
          conflict: false,
          official: false,
          enabled: true,
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
