import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { auditLogs } from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from './audit.service';
import { rfc3339UTC } from '../common/time';

const DEFAULT_RETENTION_DAYS = 180;
const RETENTION_KEY = 'audit.retention_days';

const SENSITIVE_PARAMS = new Set([
  'key', 'access_token', 'token', 'secret', 'client_secret', 'api_key', 'apikey',
  'auth', 'sign', 'signature', 'sig', 'ticket', 'password', 'passwd', 'pwd',
  'code', 'hook_token', 'webhook', 'accesstoken', 'access-token', 'api-key',
  'x-api-key', 'authorization', 'bearer', 'auth-token', 'authtoken',
  'refresh_token', 'refresh-token', 'refreshtoken', 'authorization_code',
]);

const WEBHOOK_MARKERS = ['/webhook', '/robot/send', '/bot/v2/hook', '/hooks/', '/services/'];

const URL_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|\/\/)[^\s"'<>，,。;；）)】\]]*/gi;

function urlLooksSensitive(url: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(url)) return true;
  const hashIdx = url.search(/[?#]/);
  const qs = hashIdx >= 0 ? url.slice(hashIdx + 1) : '';
  if (qs) {
    for (const pair of qs.split(/[&;]/)) {
      const key = pair.split('=')[0].toLowerCase().replace(/\[\]$/, '');
      if (SENSITIVE_PARAMS.has(key)) return true;
    }
  }
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').toLowerCase();
  return WEBHOOK_MARKERS.some((m) => path.includes(m));
}

function redactUrlKeepSchemeHost(url: string): string {
  const m = url.match(/^((?:[a-z][a-z0-9+.-]*:\/\/|\/\/)[^/\s"'<>]+)/i);
  if (m) return `${m[1]}…（已脱敏）`;
  return '（地址已脱敏）';
}

/** 脱敏审计 detail：无 report:read 权限的查看者，隐藏 URL 中的敏感信息（不回写库）。 */
function redactDetail(detail: string, action: string, canReadReport: boolean): string {
  if (canReadReport || !detail) return detail;
  const force = action.startsWith('report_subscription');
  return detail.replace(URL_RE, (url) => {
    if (!force && !urlLooksSensitive(url)) return url;
    return redactUrlKeepSchemeHost(url);
  });
}

function clampPage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 100000) return 100000;
  return Math.floor(n);
}

function clampSize(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 50;
  if (n > 500) return 500;
  return Math.floor(n);
}

/**
 * 审计管理面：列表（分页+过滤+脱敏）、保留天数设置、旧日志清理。
 * 复用已有 AuditService（log 写审计），不新建重复 service。
 */
@Injectable()
export class AuditAdminService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async list(
    pageRaw: unknown,
    sizeRaw: unknown,
    action: string | undefined,
    username: string | undefined,
    canReadReport: boolean,
  ): Promise<{ logs: Record<string, unknown>[]; total: number }> {
    const page = clampPage(pageRaw);
    const size = clampSize(sizeRaw);
    const offset = (page - 1) * size;

    const conds = [];
    if (action) conds.push(eq(auditLogs.action, action));
    if (username) conds.push(eq(auditLogs.username, username));
    const where = conds.length > 0 ? and(...conds) : undefined;

    try {
      const [rows, totalRows] = await Promise.all([
        this.db
          .select()
          .from(auditLogs)
          .where(where)
          .orderBy(desc(auditLogs.id))
          .limit(size)
          .offset(offset),
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogs)
          .where(where),
      ]);
      const logs = rows.map((r) => ({
        id: r.id,
        username: r.username,
        action: r.action,
        detail: redactDetail(r.detail, r.action, canReadReport),
        prev_hash: r.prevHash,
        hash: r.hash,
        created_at: rfc3339UTC(r.createdAt),
        app_id: '',
      }));
      return { logs, total: totalRows[0]?.count ?? 0 };
    } catch {
      throw new ApiError('INTERNAL', '查询失败');
    }
  }

  async getRetention(): Promise<{ retention_days: number }> {
    return { retention_days: await this.retentionDays() };
  }

  async setRetention(
    days: number | null | undefined,
    actor: string,
  ): Promise<{ retention_days: number }> {
    if (days === null || days === undefined || Number.isNaN(days)) {
      throw new ApiError('VALIDATION', 'retention_days 必填');
    }
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new ApiError('VALIDATION', 'retention_days 必须在 1~3650 天之间');
    }
    const old = await this.retentionDays();
    try {
      await this.settings.set(RETENTION_KEY, String(days));
    } catch {
      throw new ApiError('INTERNAL', '保存失败');
    }
    await this.purgeOld(days); // 保存后立即清理一次（失败不影响保存结果）
    await this.audit.log(actor, 'audit_retention_change', `${old}→${days}`);
    return { retention_days: days };
  }

  /** 清理超过 days 天的审计日志（保留被删批次中最新一条作为哈希链锚点）。 */
  async purgeOld(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86400_000);
    try {
      const rows = await this.db
        .delete(auditLogs)
        .where(
          sql`${auditLogs.createdAt} < ${cutoff} AND EXISTS (SELECT 1 FROM audit_logs b WHERE b.created_at < ${cutoff} AND b.id > ${auditLogs.id})`,
        )
        .returning({ id: auditLogs.id });
      return rows.length;
    } catch {
      return 0;
    }
  }

  private async retentionDays(): Promise<number> {
    const raw = await this.settings.get(RETENTION_KEY);
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
  }
}
