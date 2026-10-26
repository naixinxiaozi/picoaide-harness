import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import * as dns from 'node:dns';
import * as net from 'node:net';
import { DRIZZLE, type Database } from '../db/database.module';
import { reportSubscriptions } from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import { AuditService } from '../audit/audit.service';
import { UsageService, type UsageAggregateRow } from '../usage/usage.service';
import {
  beijingDayStr,
  beijingMonthStartUTC,
  rfc3339UTC,
} from '../common/time';

export const MASKED_HOOK_URL = '***';
export const RETRY_FIRST_DELAY_MS = 3600_000; // 1h
export const RETRY_MAX_DELAY_MS = 86400_000; // 24h
export const RPT_LOCK_CLASS = 0x52505431; // "RPT1"
const PUSH_TIMEOUT_MS = 10_000;

const VALIDATE_HOOK_BAD_SCHEME = '必须是 http(s) URL';
const VALIDATE_HOOK_NO_HOST = '缺少主机名';
const VALIDATE_HOOK_BLOCKED = '不允许指向内网/回环地址';
const VALIDATE_HOOK_UNRESOLVABLE = '目标主机无法解析';
const VALIDATE_HOOK_PARSE = '目标地址格式无法解析';

interface SubscriptionRow {
  id: number;
  name: string;
  enabled: number;
  hookUrl: string;
  lastRunAt: Date | null;
  lastError: string;
  pendingPeriod: string;
  failStreak: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ReportTotal {
  cost: number;
  requests: number;
  tokens: number;
}

interface ReportBody {
  type: 'monthly_usage_report';
  period: string;
  generated_at: string;
  total: ReportTotal;
  top_models: UsageAggregateRow[];
  top_users: UsageAggregateRow[];
  departments: UsageAggregateRow[];
}

function maskHookURL(raw: string): string {
  return raw.trim() === '' ? '' : MASKED_HOOK_URL;
}

function toJSON(sub: SubscriptionRow): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: sub.id,
    name: sub.name,
    enabled: sub.enabled === 1,
    hook_url: maskHookURL(sub.hookUrl),
    last_error: sub.lastError,
    created_at: rfc3339UTC(sub.createdAt),
    updated_at: rfc3339UTC(sub.updatedAt),
  };
  if (sub.lastRunAt) out.last_run_at = rfc3339UTC(sub.lastRunAt);
  if (sub.pendingPeriod) out.pending_period = sub.pendingPeriod;
  if (sub.failStreak) out.fail_streak = sub.failStreak;
  if (sub.nextAttemptAt) out.next_attempt_at = rfc3339UTC(sub.nextAttemptAt);
  return out;
}

/** 上一个月（北京时区）的 "YYYY-MM"。 */
function currentPeriod(now: Date): string {
  const p = beijingParts(now);
  const y = p.month === 0 ? p.year - 1 : p.year;
  const m = p.month === 0 ? 11 : p.month - 1;
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

function beijingParts(d: Date): { year: number; month: number; day: number } {
  const t = new Date(d.getTime() + 8 * 3600_000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth(), day: t.getUTCDate() };
}

function shouldRunMonthly(now: Date, lastRunAt: Date | null): boolean {
  if (!lastRunAt) return true;
  const nowM = beijingMonthKey(now);
  const lastM = beijingMonthKey(lastRunAt);
  return lastM < nowM;
}

function beijingMonthKey(d: Date): number {
  const p = beijingParts(d);
  return p.year * 100 + (p.month + 1);
}

function periodAfter(period: string): string {
  const [y, m] = period.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return '';
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function sanitizeReportError(errMsg: string): string {
  const msg = errMsg.trim();
  if (!msg.includes('://')) return msg.length > 200 ? msg.slice(0, 200) : msg;
  if (msg.includes('hook_url 不合法')) return '目标地址被拒(内网/回环/无法解析)';
  if (msg.includes('webhook status')) return 'webhook 返回非 2xx';
  if (msg.includes('no such host') || msg.includes('ENOTFOUND')) return '目标主机无法解析';
  if (msg.includes('connection refused') || msg.includes('ECONNREFUSED')) return '目标拒绝连接';
  if (msg.includes('deadline') || msg.includes('timeout') || msg.includes('ETIMEDOUT')) return '推送超时';
  if (msg.includes('tls') || msg.includes('certificate') || msg.includes('CERT')) return 'TLS 握手失败';
  if (
    msg.includes('invalid URL') ||
    msg.includes('missing protocol') ||
    msg.includes('first path segment')
  ) {
    return '目标地址格式无法解析';
  }
  return '推送失败';
}

/** SSRF：ipv4 区间与 ipv6 前缀（与 Go blockedHookCIDRList 对齐）。 */
function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [ipv4ToInt('0.0.0.0'), ipv4ToInt('0.255.255.255')],
  [ipv4ToInt('10.0.0.0'), ipv4ToInt('10.255.255.255')],
  [ipv4ToInt('100.64.0.0'), ipv4ToInt('100.127.255.255')],
  [ipv4ToInt('127.0.0.0'), ipv4ToInt('127.255.255.255')],
  [ipv4ToInt('169.254.0.0'), ipv4ToInt('169.254.255.255')],
  [ipv4ToInt('172.16.0.0'), ipv4ToInt('172.31.255.255')],
  [ipv4ToInt('192.0.0.0'), ipv4ToInt('192.0.0.255')],
  [ipv4ToInt('192.0.2.0'), ipv4ToInt('192.0.2.255')],
  [ipv4ToInt('192.168.0.0'), ipv4ToInt('192.168.255.255')],
  [ipv4ToInt('198.18.0.0'), ipv4ToInt('198.19.255.255')],
  [ipv4ToInt('198.51.100.0'), ipv4ToInt('198.51.100.255')],
  [ipv4ToInt('203.0.113.0'), ipv4ToInt('203.0.113.255')],
  [ipv4ToInt('224.0.0.0'), ipv4ToInt('239.255.255.255')],
  [ipv4ToInt('240.0.0.0'), ipv4ToInt('255.255.255.255')],
];

function expandIPv6(ip: string): string | null {
  let s = ip;
  const zi = s.indexOf('%');
  if (zi >= 0) s = s.slice(0, zi);
  s = s.toLowerCase();
  if (s.includes('::')) {
    const [left, right] = s.split('::');
    const lp = left ? left.split(':') : [];
    const rp = right ? right.split(':') : [];
    const missing = 8 - lp.length - rp.length;
    if (missing < 0) return null;
    const parts = [...lp, ...new Array(missing).fill('0'), ...rp];
    return parts.map((g) => g.padStart(4, '0')).join(':');
  }
  const parts = s.split(':');
  if (parts.length !== 8) return null;
  return parts.map((g) => g.padStart(4, '0')).join(':');
}

function ipv6Bits(expanded: string): string {
  return expanded
    .replace(/:/g, '')
    .split('')
    .map((h) => parseInt(h, 16).toString(2).padStart(4, '0'))
    .join('');
}

const BLOCKED_IPV6_PREFIXES: Array<[string, number]> = [
  ['0000:0000:0000:0000:0000:0000:0000:0000', 128],
  ['0000:0000:0000:0000:0000:0000:0000:0001', 128],
  ['2001:0000:0000:0000:0000:0000:0000:0000', 32],
  ['2002:0000:0000:0000:0000:0000:0000:0000', 16],
  ['0064:ff9b:0000:0000:0000:0000:0000:0000', 96],
  ['0064:ff9b:0001:0000:0000:0000:0000:0000', 48],
  ['0100:0000:0000:0000:0000:0000:0000:0000', 64],
  ['2001:0db8:0000:0000:0000:0000:0000:0000', 32],
  ['fc00:0000:0000:0000:0000:0000:0000:0000', 7],
  ['fe80:0000:0000:0000:0000:0000:0000:0000', 10],
  ['fec0:0000:0000:0000:0000:0000:0000:0000', 10],
  ['ff00:0000:0000:0000:0000:0000:0000:0000', 8],
];

function isBlockedIP(ip: string): boolean {
  if (net.isIP(ip) === 4) {
    const n = ipv4ToInt(ip);
    return BLOCKED_IPV4_RANGES.some(([s, e]) => n >= s && n <= e);
  }
  if (net.isIP(ip) === 6) {
    const expanded = expandIPv6(ip);
    if (!expanded) return true; // 无法解析 → 按阻断处理（fail-closed）
    const bits = ipv6Bits(expanded);
    for (const [prefix, len] of BLOCKED_IPV6_PREFIXES) {
      if (bits.startsWith(ipv6Bits(prefix).slice(0, len))) return true;
    }
    return false;
  }
  return true;
}

/** 校验 webhook URL：返回空串=通过，否则返回中文拒绝原因。 */
async function validateHookURL(raw: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return VALIDATE_HOOK_PARSE;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return VALIDATE_HOOK_BAD_SCHEME;
  if (!u.hostname) return VALIDATE_HOOK_NO_HOST;
  try {
    const addrs = await dns.promises.lookup(u.hostname, { all: true });
    for (const a of addrs) {
      if (isBlockedIP(a.address)) return VALIDATE_HOOK_BLOCKED;
    }
  } catch {
    return VALIDATE_HOOK_UNRESOLVABLE;
  }
  return '';
}

/**
 * 报表订阅：CRUD + 测试推送 + 月度投递（含 SSRF 防护、退避重试、advisory lock）。
 */
@Injectable()
export class ReportSubscriptionsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<{ subscriptions: Record<string, unknown>[] }> {
    try {
      const rows = await this.db
        .select()
        .from(reportSubscriptions)
        .orderBy(reportSubscriptions.id);
      return { subscriptions: rows.map(toJSON) };
    } catch {
      throw new ApiError('INTERNAL', '查询失败');
    }
  }

  async create(actor: string, body: unknown): Promise<{ id: number }> {
    const { name, hookURL, enabled, msg } = await this.validateCreate(body);
    if (msg) throw new ApiError('VALIDATION', msg);
    try {
      const [row] = await this.db
        .insert(reportSubscriptions)
        .values({ name, hookUrl: hookURL, enabled: enabled ? 1 : 0 })
        .returning({ id: reportSubscriptions.id });
      await this.audit.log(actor, 'report_subscription_create', `${name} (id=${row.id})`);
      return { id: row.id };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('INTERNAL', '创建失败');
    }
  }

  async update(actor: string, idRaw: string, body: unknown): Promise<{ ok: boolean }> {
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError('VALIDATION', '无效 ID');
    const b = isPlainObject(body) ? body : {};
    const name = String(b.name ?? '').trim();
    if (name === '') throw new ApiError('VALIDATION', '订阅名称必填');

    let hookURL = '';
    const rawHook = String(b.hook_url ?? '').trim();
    if (rawHook !== '' && rawHook !== MASKED_HOOK_URL) {
      if (!rawHook.startsWith('http://') && !rawHook.startsWith('https://')) {
        throw new ApiError('VALIDATION', 'hook_url 必须是 http(s) URL');
      }
      const err = await validateHookURL(rawHook);
      if (err) throw new ApiError('VALIDATION', `hook_url 不合法: ${err}`);
      hookURL = rawHook;
    }
    const enabled = b.enabled === undefined ? undefined : !!b.enabled;

    try {
      const existing = await this.db
        .select()
        .from(reportSubscriptions)
        .where(eq(reportSubscriptions.id, id))
        .limit(1);
      if (existing.length === 0) throw new ApiError('NOT_FOUND', '订阅不存在');

      const cur = existing[0];
      const nextEnabled = enabled === undefined ? cur.enabled === 1 : enabled;
      // hook_url 变更时清空 last_error 并重置 fail_streak/next_attempt_at（不清 pending_period）
      const addressChanged = hookURL !== '' && hookURL !== cur.hookUrl;
      await this.db
        .update(reportSubscriptions)
        .set({
          name,
          enabled: nextEnabled ? 1 : 0,
          ...(addressChanged
            ? { hookUrl: hookURL, lastError: '', failStreak: 0, nextAttemptAt: null }
            : {}),
        })
        .where(eq(reportSubscriptions.id, id));
      await this.audit.log(actor, 'report_subscription_update', `${name} (id=${id})`);
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('INTERNAL', '更新失败');
    }
  }

  async remove(actor: string, idRaw: string): Promise<{ ok: boolean }> {
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError('VALIDATION', '无效 ID');
    try {
      const rows = await this.db
        .delete(reportSubscriptions)
        .where(eq(reportSubscriptions.id, id))
        .returning({ id: reportSubscriptions.id });
      if (rows.length === 0) throw new ApiError('NOT_FOUND', '订阅不存在');
      await this.audit.log(actor, 'report_subscription_delete', String(id));
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('INTERNAL', '删除失败');
    }
  }

  async testPush(idRaw: string): Promise<{ ok: boolean; period: string }> {
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError('VALIDATION', '无效 ID');
    let rows: SubscriptionRow[];
    try {
      rows = await this.db
        .select()
        .from(reportSubscriptions)
        .where(eq(reportSubscriptions.id, id))
        .limit(1);
    } catch {
      throw new ApiError('INTERNAL', '查询失败');
    }
    if (rows.length === 0) throw new ApiError('NOT_FOUND', '订阅不存在');

    const sub = rows[0];
    let body: ReportBody;
    try {
      body = await this.generateMonthlyReport(currentPeriod(new Date()));
    } catch (e) {
      throw new ApiError('INTERNAL', `报表生成失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      await this.pushWebhook(sub.hookUrl, body);
    } catch (e) {
      throw new ApiError('UPSTREAM', `推送失败: ${sanitizeReportError(e instanceof Error ? e.message : String(e))}`, 502);
    }
    return { ok: true, period: body.period };
  }

  /** 生成上一自然月（北京时区）的月报。period = "YYYY-MM"。 */
  async generateMonthlyReport(period: string): Promise<ReportBody> {
    const [y, m] = period.split('-').map(Number);
    const start = beijingMonthStartUTC(y, m - 1);
    const next = beijingMonthStartUTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m);
    const lastDay = new Date(next.getTime() - 86400_000);
    const fromStr = beijingDayStr(start);
    const toStr = beijingDayStr(lastDay);

    const [trend, models, users, depts] = await Promise.all([
      this.usage.aggregate(fromStr, toStr, 'day', {}),
      this.usage.aggregate(fromStr, toStr, 'model', {}),
      this.usage.aggregate(fromStr, toStr, 'user', {}),
      this.usage.aggregate(fromStr, toStr, 'dept', {}),
    ]);

    let cost = 0;
    let requests = 0;
    let tokens = 0;
    for (const r of trend.rows) {
      cost += r.cost;
      requests += r.requests;
      tokens += r.prompt_tokens + r.completion_tokens - r.embed_tokens;
    }

    return {
      type: 'monthly_usage_report',
      period,
      generated_at: rfc3339UTC(new Date()),
      total: { cost, requests, tokens },
      top_models: topByCost(models.rows, 10),
      top_users: topByCost(users.rows, 10),
      departments: topByCost(depts.rows, 20),
    };
  }

  /** 调度器入口：投递所有到期订阅，返回 {ok, failed}。 */
  async dispatchDue(now: Date): Promise<{ ok: number; failed: number }> {
    let subs: SubscriptionRow[];
    try {
      subs = await this.db.select().from(reportSubscriptions);
    } catch {
      return { ok: 0, failed: 0 };
    }
    let ok = 0;
    let failed = 0;
    for (const sub of subs) {
      const due = this.subscriptionDuePeriod(now, sub);
      if (!due.due) continue;
      const success = await this.dispatchOne(sub, due.period, now);
      if (success) ok += 1;
      else failed += 1;
    }
    return { ok, failed };
  }

  private subscriptionDuePeriod(
    now: Date,
    sub: SubscriptionRow,
  ): { period: string; due: boolean } {
    if (sub.enabled !== 1) return { period: '', due: false };
    if (sub.nextAttemptAt && sub.nextAttemptAt.getTime() > now.getTime()) {
      return { period: '', due: false };
    }
    if (sub.pendingPeriod) {
      const p = sub.pendingPeriod;
      if (!/^\d{4}-\d{2}$/.test(p)) return { period: '', due: false }; // malformed → fail-closed
      if (p < '0001-01') return { period: '', due: false }; // unreachable
      const floor = sub.createdAt ? currentPeriod(sub.createdAt) : '';
      if (floor && p < floor) return { period: '', due: false }; // before floor
      if (p >= currentPeriod(now)) return { period: '', due: false }; // future
      return { period: p, due: true };
    }
    if (!shouldRunMonthly(now, sub.lastRunAt)) return { period: '', due: false };
    return { period: currentPeriod(now), due: true };
  }

  private async dispatchOne(
    sub: SubscriptionRow,
    period: string,
    now: Date,
  ): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        const lockRows = await tx.execute(
          sql`SELECT pg_try_advisory_lock(${RPT_LOCK_CLASS}::int, ${sub.id}::int) AS ok`,
        );
        const acquired =
          Array.isArray(lockRows) &&
          lockRows.length > 0 &&
          (lockRows[0] as { ok: boolean }).ok === true;
        if (!acquired) return false;
        try {
          const freshRows = await tx
            .select()
            .from(reportSubscriptions)
            .where(eq(reportSubscriptions.id, sub.id))
            .limit(1);
          if (freshRows.length === 0) return false;
          const fresh = freshRows[0];
          const due = this.subscriptionDuePeriod(now, fresh);
          if (!due.due) return false;

          const body = await this.generateMonthlyReport(due.period);
          let err = '';
          try {
            await this.pushWebhook(fresh.hookUrl, body);
          } catch (e) {
            err = sanitizeReportError(e instanceof Error ? e.message : String(e));
          }

          if (!err) {
            const nextPending = this.nextPendingAfterDelivery(now, due.period);
            await tx
              .update(reportSubscriptions)
              .set({
                lastRunAt: new Date(),
                lastError: '',
                failStreak: 0,
                nextAttemptAt: null,
                pendingPeriod: nextPending || fresh.pendingPeriod,
              })
              .where(eq(reportSubscriptions.id, fresh.id));
            return true;
          }
          const nextAttempt = new Date(
            now.getTime() + (fresh.failStreak <= 0 ? RETRY_FIRST_DELAY_MS : RETRY_MAX_DELAY_MS),
          );
          await tx
            .update(reportSubscriptions)
            .set({
              lastError: err,
              failStreak: fresh.failStreak + 1,
              nextAttemptAt: nextAttempt,
              pendingPeriod: fresh.pendingPeriod === '' ? due.period : fresh.pendingPeriod,
            })
            .where(eq(reportSubscriptions.id, fresh.id));
          return false;
        } finally {
          await tx.execute(
            sql`SELECT pg_advisory_unlock(${RPT_LOCK_CLASS}::int, ${sub.id}::int)`,
          );
        }
      });
    } catch {
      return false;
    }
  }

  private nextPendingAfterDelivery(now: Date, period: string): string {
    if (!period) return '';
    if (period >= currentPeriod(now)) return '';
    return periodAfter(period);
  }

  private async pushWebhook(hookURL: string, body: ReportBody): Promise<void> {
    const err = await validateHookURL(hookURL);
    if (err) throw new Error(`hook_url 不合法: ${err}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
    try {
      const resp = await fetch(hookURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: controller.signal,
      });
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`webhook status ${resp.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async validateCreate(
    body: unknown,
  ): Promise<{ name: string; hookURL: string; enabled: boolean; msg: string }> {
    if (!isPlainObject(body)) {
      return { name: '', hookURL: '', enabled: true, msg: '请求体格式错误' };
    }
    const name = String(body.name ?? '').trim();
    if (name === '') {
      return { name: '', hookURL: '', enabled: true, msg: '订阅名称必填' };
    }
    const hookURL = String(body.hook_url ?? '').trim();
    if (!hookURL.startsWith('http://') && !hookURL.startsWith('https://')) {
      return { name, hookURL: '', enabled: true, msg: 'hook_url 必须是 http(s) URL' };
    }
    const err = await validateHookURL(hookURL);
    if (err) return { name, hookURL: '', enabled: true, msg: `hook_url 不合法: ${err}` };
    const enabled = body.enabled === undefined ? true : !!body.enabled;
    return { name, hookURL, enabled, msg: '' };
  }
}

function topByCost(rows: UsageAggregateRow[], n: number): UsageAggregateRow[] {
  return [...rows]
    .sort((a, b) => b.cost - a.cost || a.label.localeCompare(b.label))
    .slice(0, n);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
