import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, Database } from '../db/database.module';
import { gatewayProviders, groups, models, usage, userGroups, users } from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import {
  beijingDayStartUTC,
  beijingDayStr,
  beijingMonthKey,
  beijingMonthStartUTC,
  beijingParts,
} from '../common/time';

const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 90;
const MAX_USER_ROWS = 500;
const TOP_MODELS = 10;
const UNASSIGNED_PROVIDER = '(未配置渠道)';

const VALID_GROUPS = ['day', 'week', 'month', 'model', 'user', 'dept', 'provider'];
const VALID_KINDS = new Set(['chat', 'completions', 'responses', 'embedding', 'search']);

export interface UsageAggregateRow {
  label: string;
  prompt_tokens: number;
  completion_tokens: number;
  requests: number;
  embed_requests: number;
  embed_tokens: number;
  cache_tokens: number;
  cost: number;
}

export interface UsageRequestRow {
  id: number;
  time: string;
  user_id: number;
  username: string;
  model: string;
  kind: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_tokens: number;
  search_requests: number;
  cost: number;
  estimated: boolean;
}

type RawAggRow = {
  label: string;
  pt: number;
  ct: number;
  req: number;
  ereq: number;
  etok: number;
  ctk: number;
  cost: number;
};

@Injectable()
export class UsageService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private parseDay(raw: string | undefined, errMsg: string): Date | null {
    if (raw === undefined) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ApiError('VALIDATION', errMsg, 400);
    const [y, m, d] = raw.split('-').map((x) => Number(x));
    if (m < 1 || m > 12 || d < 1 || d > 31) throw new ApiError('VALIDATION', errMsg, 400);
    return beijingDayStartUTC(y, m - 1, d);
  }

  private resolveRange(fromRaw?: string, toRaw?: string): { from: Date; to: Date } {
    let from = this.parseDay(fromRaw, 'from 日期格式错误(YYYY-MM-DD)');
    let to = this.parseDay(toRaw, 'to 日期格式错误(YYYY-MM-DD)');

    if (from === null && to === null) {
      const p = beijingParts(new Date());
      to = beijingDayStartUTC(p.year, p.month, p.day);
      from = new Date(to.getTime() - (DEFAULT_WINDOW_DAYS - 1) * 86400000);
    } else if (from === null) {
      from = new Date(to!.getTime() - (MAX_WINDOW_DAYS - 1) * 86400000);
    } else if (to === null) {
      to = new Date(from!.getTime() + (MAX_WINDOW_DAYS - 1) * 86400000);
    }

    if (from!.getTime() > to!.getTime()) throw new ApiError('VALIDATION', '起始日期不能晚于结束日期', 400);
    return { from: from!, to: to! };
  }

  async aggregate(
    fromRaw: string | undefined,
    toRaw: string | undefined,
    group: string,
    opts: { username?: string; dept?: string; model?: string; kind?: string },
  ): Promise<{ rows: UsageAggregateRow[]; group: string; truncated: boolean }> {
    if (!VALID_GROUPS.includes(group)) {
      throw new ApiError('VALIDATION', 'group 必须是 day|week|month|model|user|dept|provider', 400);
    }
    const { from, to } = this.resolveRange(fromRaw, toRaw);
    const toEx = new Date(to.getTime() + 86400000);

    let deptGroupIds: number[] | null = null;
    if (opts.dept) {
      deptGroupIds = await this.deptSubtreeIds(opts.dept);
      if (deptGroupIds.length === 0) {
        return { rows: [], group, truncated: false };
      }
    }

    let truncated = false;
    let rows: UsageAggregateRow[];

    if (group === 'dept') {
      const userRows = await this.aggregateInternal(from, toEx, 'user', {
        username: opts.username,
        model: opts.model,
        kind: opts.kind,
        deptGroupIds,
      });
      rows = await this.regroupByDept(userRows);
    } else if (group === 'provider') {
      const modelRows = await this.aggregateInternal(from, toEx, 'model', {
        username: opts.username,
        model: opts.model,
        kind: opts.kind,
        deptGroupIds,
      });
      rows = await this.regroupByProvider(modelRows);
    } else {
      rows = await this.aggregateInternal(from, toEx, group, {
        username: opts.username,
        model: opts.model,
        kind: opts.kind,
        deptGroupIds,
      });
      if (group === 'day' || group === 'week' || group === 'month') {
        rows = this.fillRows(rows, group, from, to);
      } else if (group === 'user' && rows.length > MAX_USER_ROWS) {
        rows = rows.slice(0, MAX_USER_ROWS);
        truncated = true;
      }
    }

    return { rows, group, truncated };
  }

  private async aggregateInternal(
    from: Date,
    toEx: Date,
    group: string,
    opts: { username?: string; model?: string; kind?: string; deptGroupIds?: number[] | null },
  ): Promise<UsageAggregateRow[]> {
    const bjWall = `(usage.created_at AT TIME ZONE 'UTC' + interval '8 hours')`;
    let labelExpr: string;
    let groupBy: string;
    let join = '';
    if (group === 'day') {
      labelExpr = `to_char(${bjWall}, 'YYYY-MM-DD')`;
      groupBy = labelExpr;
    } else if (group === 'week') {
      labelExpr = `to_char(date_trunc('week', ${bjWall})::date, 'YYYY-MM-DD')`;
      groupBy = labelExpr;
    } else if (group === 'month') {
      labelExpr = `to_char(${bjWall}, 'YYYY-MM')`;
      groupBy = labelExpr;
    } else if (group === 'model') {
      labelExpr = `usage.model`;
      groupBy = `usage.model`;
    } else {
      labelExpr = `COALESCE(u.username, CAST(usage.user_id AS TEXT))`;
      groupBy = `u.username, usage.user_id`;
      join = ` LEFT JOIN users u ON u.id = usage.user_id`;
    }

    const { username, model, kind, deptGroupIds } = opts;
    const rows = await this.db.execute<RawAggRow>(sql`
      SELECT ${sql.raw(labelExpr)} AS label,
        SUM(prompt_tokens)::float8 AS pt,
        SUM(completion_tokens)::float8 AS ct,
        COUNT(*)::int AS req,
        SUM(CASE WHEN kind = 'embedding' THEN 1 ELSE 0 END)::int AS ereq,
        SUM(CASE WHEN kind = 'embedding' THEN prompt_tokens ELSE 0 END)::float8 AS etok,
        SUM(cache_prompt_tokens)::float8 AS ctk,
        SUM(cost)::float8 AS cost
      FROM usage${sql.raw(join)}
      WHERE created_at >= ${from} AND created_at < ${toEx}
        ${username ? sql`AND usage.user_id = (SELECT id FROM users WHERE username = ${username})` : sql``}
        ${model ? sql`AND usage.model = ${model}` : sql``}
        ${kind ? sql`AND usage.kind = ${kind}` : sql``}
        ${deptGroupIds && deptGroupIds.length > 0 ? sql`AND usage.user_id IN (SELECT user_id FROM user_groups WHERE group_id = ANY(${deptGroupIds}::bigint[]))` : sql``}
      GROUP BY ${sql.raw(groupBy)}
      ORDER BY label
    `);

    return rows.map((r) => ({
      label: String(r.label),
      prompt_tokens: Number(r.pt),
      completion_tokens: Number(r.ct),
      requests: Number(r.req),
      embed_requests: Number(r.ereq),
      embed_tokens: Number(r.etok),
      cache_tokens: Number(r.ctk),
      cost: Number(r.cost),
    }));
  }

  private zeroRow(label: string): UsageAggregateRow {
    return {
      label,
      prompt_tokens: 0,
      completion_tokens: 0,
      requests: 0,
      embed_requests: 0,
      embed_tokens: 0,
      cache_tokens: 0,
      cost: 0,
    };
  }

  private fillRows(rows: UsageAggregateRow[], group: string, from: Date, to: Date): UsageAggregateRow[] {
    const map = new Map(rows.map((r) => [r.label, r]));
    const out: UsageAggregateRow[] = [];
    if (group === 'day') {
      for (let ms = from.getTime(); ms <= to.getTime(); ms += 86400000) {
        const key = beijingDayStr(new Date(ms));
        out.push(map.get(key) ?? this.zeroRow(key));
      }
      return out;
    }
    if (group === 'week') {
      const start = this.weekMonday(from);
      for (let ms = start.getTime(); ms <= to.getTime(); ms += 7 * 86400000) {
        const key = beijingDayStr(new Date(ms));
        out.push(map.get(key) ?? this.zeroRow(key));
      }
      return out;
    }
    // month
    let cur = this.monthStart(from);
    const last = this.monthStart(to);
    while (cur.getTime() <= last.getTime()) {
      const p = beijingParts(cur);
      const key = `${p.year}-${String(p.month + 1).padStart(2, '0')}`;
      out.push(map.get(key) ?? this.zeroRow(key));
      const ny = p.month === 11 ? p.year + 1 : p.year;
      const nm = p.month === 11 ? 0 : p.month + 1;
      cur = beijingMonthStartUTC(ny, nm);
    }
    return out;
  }

  private monthStart(d: Date): Date {
    const p = beijingParts(d);
    return beijingMonthStartUTC(p.year, p.month);
  }

  private weekMonday(d: Date): Date {
    const wd = d.getUTCDay();
    const offset = (wd + 6) % 7;
    return new Date(d.getTime() - offset * 86400000);
  }

  private async regroupByProvider(rows: UsageAggregateRow[]): Promise<UsageAggregateRow[]> {
    const mapRows = await this.db.execute<{ name: string; provider: string }>(sql`
      SELECT m.name, COALESCE(p.name, '') AS provider
      FROM models m LEFT JOIN gateway_providers p ON p.id = m.provider_id
      ORDER BY m.id
    `);
    const providerMap = new Map<string, string>();
    for (const r of mapRows) {
      if (!providerMap.has(r.name)) providerMap.set(r.name, r.provider);
    }
    const agg = new Map<string, UsageAggregateRow>();
    for (const row of rows) {
      const provider = providerMap.get(row.label) || UNASSIGNED_PROVIDER;
      const existing = agg.get(provider);
      if (existing) {
        existing.prompt_tokens += row.prompt_tokens;
        existing.completion_tokens += row.completion_tokens;
        existing.requests += row.requests;
        existing.embed_requests += row.embed_requests;
        existing.embed_tokens += row.embed_tokens;
        existing.cache_tokens += row.cache_tokens;
        existing.cost += row.cost;
      } else {
        agg.set(provider, { ...row, label: provider });
      }
    }
    return Array.from(agg.values()).sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label));
  }

  private async regroupByDept(rows: UsageAggregateRow[]): Promise<UsageAggregateRow[]> {
    const tree = await this.loadGroupTree();
    const depts = await this.userDepts(tree);
    const usersById = new Map<number, string>();
    if (rows.length > 0) {
      const userRows = await this.db.execute<{ id: number; username: string }>(
        sql`SELECT id, username FROM users WHERE id = ANY(${rows.map((r) => Number(r.label)).filter((n) => Number.isInteger(n))}::bigint[])`,
      );
      for (const r of userRows) {
        usersById.set(Number(r.id), r.username);
      }
    }
    const agg = new Map<string, UsageAggregateRow>();
    const add = (label: string, row: UsageAggregateRow) => {
      const existing = agg.get(label);
      if (existing) {
        existing.prompt_tokens += row.prompt_tokens;
        existing.completion_tokens += row.completion_tokens;
        existing.requests += row.requests;
        existing.embed_requests += row.embed_requests;
        existing.embed_tokens += row.embed_tokens;
        existing.cache_tokens += row.cache_tokens;
        existing.cost += row.cost;
      } else {
        agg.set(label, { ...row, label });
      }
    };
    for (const row of rows) {
      const uid = Number(row.label);
      let deptList: string[] = [];
      if (Number.isInteger(uid)) {
        deptList = depts.get(uid) ?? [usersById.get(uid) ?? row.label];
      } else {
        // username label — find id by username
        const found = await this.db.execute<{ id: number }>(sql`SELECT id FROM users WHERE username = ${row.label} LIMIT 1`);
        if (found.length > 0) {
          deptList = depts.get(Number(found[0].id)) ?? [row.label];
        } else {
          deptList = [row.label];
        }
      }
      for (const d of deptList) add(d, row);
    }
    return Array.from(agg.values()).sort((a, b) => a.label.localeCompare(b.label));
  }

  async overview() {
    const now = new Date();
    const p = beijingParts(now);
    const today = beijingDayStartUTC(p.year, p.month, p.day);
    const { from, to } = this.resolveRange(undefined, undefined);
    const monthFrom = beijingMonthStartUTC(p.year, p.month);

    const rangeRows = await this.aggregateInternal(from, new Date(to.getTime() + 86400000), 'day', {});
    const modelRows = await this.aggregateInternal(from, new Date(to.getTime() + 86400000), 'model', {});
    const monthRows = await this.aggregateInternal(monthFrom, new Date(today.getTime() + 86400000), 'day', {});
    const todayRows = await this.aggregateInternal(today, new Date(today.getTime() + 86400000), 'day', {});

    const topModels = [...modelRows]
      .sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label))
      .slice(0, TOP_MODELS);

    return {
      range: this.sum(rangeRows),
      month: this.sum(monthRows),
      today: this.sum(todayRows),
      trend: this.fillRows(rangeRows, 'day', from, to),
      top_models: topModels,
    };
  }

  private sum(rows: UsageAggregateRow[]): { cost: number; tokens: number; requests: number } {
    let cost = 0;
    let tokens = 0;
    let requests = 0;
    for (const r of rows) {
      cost += r.cost;
      tokens += r.prompt_tokens + r.completion_tokens;
      requests += r.requests;
    }
    return { cost, tokens, requests };
  }

  async requests(
    fromRaw: string | undefined,
    toRaw: string | undefined,
    username: string | undefined,
    model: string | undefined,
    kind: string | undefined,
    pageRaw: string | undefined,
    sizeRaw: string | undefined,
  ): Promise<{ rows: UsageRequestRow[]; total: number; page: number; size: number; kind: string }> {
    const { from, to } = this.resolveRange(fromRaw, toRaw);
    const toEx = new Date(to.getTime() + 86400000);
    if (from.getTime() + MAX_WINDOW_DAYS * 86400000 < toEx.getTime()) {
      throw new ApiError('VALIDATION', '查询窗口最长 90 天', 400);
    }
    const k = kind ?? '';
    if (k !== '' && !VALID_KINDS.has(k)) {
      throw new ApiError('VALIDATION', 'kind 必须是 chat|embedding|search', 400);
    }
    const page = Number(pageRaw ?? '1');
    const size = Number(sizeRaw ?? '20');
    const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
    const s = Number.isFinite(size) && size >= 1 && size <= 100 ? Math.floor(size) : 20;
    const offset = (p - 1) * s;

    const conds = [sql`${usage.createdAt} >= ${from}`, sql`${usage.createdAt} < ${toEx}`];
    if (username) conds.push(sql`${usage.userId} = (SELECT id FROM users WHERE username = ${username})`);
    if (model) conds.push(eq(usage.model, model));
    if (k !== '') conds.push(eq(usage.kind, k as never));

    const countRows = await this.db
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(usage)
      .where(and(...conds));
    const total = Number(countRows[0].c);

    const rows = await this.db
      .select({
        id: usage.id,
        createdAt: usage.createdAt,
        userId: usage.userId,
        username: sql<string>`COALESCE(${users.username}, '')`,
        model: usage.model,
        kind: usage.kind,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cacheTokens: usage.cachePromptTokens,
        searchRequests: usage.searchRequests,
        cost: usage.cost,
        estimated: usage.estimated,
      })
      .from(usage)
      .leftJoin(users, eq(users.id, usage.userId))
      .where(and(...conds))
      .orderBy(desc(usage.id))
      .limit(s)
      .offset(offset);

    const items: UsageRequestRow[] = rows.map((r) => ({
      id: r.id,
      time: r.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      user_id: r.userId,
      username: r.username ?? '',
      model: r.model,
      kind: r.kind,
      prompt_tokens: Number(r.promptTokens),
      completion_tokens: Number(r.completionTokens),
      cache_tokens: Number(r.cacheTokens),
      search_requests: Number(r.searchRequests),
      cost: Number(r.cost),
      estimated: r.estimated,
    }));

    return { rows: items, total, page: p, size: s, kind: k };
  }

  private async loadGroupTree(): Promise<Map<number, number[]>> {
    const all = await this.db.select({ id: groups.id, parentId: groups.parentId }).from(groups);
    const children = new Map<number, number[]>();
    for (const g of all) {
      const list = children.get(g.parentId) ?? [];
      list.push(g.id);
      children.set(g.parentId, list);
    }
    return children;
  }

  private async deptSubtreeIds(deptName: string): Promise<number[]> {
    const all = await this.db
      .select({ id: groups.id, name: groups.name, parentId: groups.parentId })
      .from(groups);
    const root = all.find((g) => g.name.toLowerCase() === deptName.toLowerCase());
    if (!root) return [];
    const children = new Map<number, number[]>();
    for (const g of all) {
      const list = children.get(g.parentId) ?? [];
      list.push(g.id);
      children.set(g.parentId, list);
    }
    const result: number[] = [];
    const stack = [root.id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      result.push(cur);
      for (const c of children.get(cur) ?? []) stack.push(c);
    }
    return result;
  }

  private async userDepts(tree: Map<number, number[]>): Promise<Map<number, string[]>> {
    const all = await this.db
      .select({ id: groups.id, name: groups.name, parentId: groups.parentId })
      .from(groups);
    const nameById = new Map<number, string>(all.map((g) => [g.id, g.name]));
    const ancestors = new Map<number, number[]>();
    const path = (id: number): number[] => {
      const cached = ancestors.get(id);
      if (cached) return cached;
      const chain: number[] = [];
      let cur: number | undefined = id;
      while (cur !== undefined && cur !== 0) {
        chain.push(cur);
        cur = all.find((g) => g.id === cur)?.parentId ?? undefined;
      }
      ancestors.set(id, chain);
      return chain;
    };
    const links = await this.db
      .select({ userId: userGroups.userId, groupId: userGroups.groupId })
      .from(userGroups);
    const result = new Map<number, string[]>();
    for (const l of links) {
      const list = result.get(l.userId) ?? [];
      for (const gid of path(l.groupId)) {
        const name = nameById.get(gid);
        if (name && !list.includes(name)) list.push(name);
      }
      result.set(l.userId, list);
    }
    return result;
  }
}
