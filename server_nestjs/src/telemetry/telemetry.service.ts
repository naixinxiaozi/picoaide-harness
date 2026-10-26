import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { clientErrorReportingStatus, skills, skillGrants } from '../db/schema';
import { ApiError } from '../common/errors/api-error';
import { resolveUserEffectiveGroups } from '../common/effective-groups';
import { granteeMatch } from '../common/skills-shared';
import { SlidingWindowLimiter } from '../common/rate-limiter';
import type { ClientPrincipal } from '../common/decorators';

const ERROR_REPORTING_STATES = new Set([
  'idle',
  'disabled',
  'ready',
  'failed',
  'config_unavailable',
]);
const ERROR_REPORTING_LEVELS = new Set(['', 'debug', 'info', 'warning', 'error']);

const MAX_NAME_LEN = 128;
const MAX_DSN_HOST_LEN = 253;

function stripControlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 0x0a || c === 0x09) {
      out += ch;
      continue;
    }
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

function truncateRunes(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function validDSNHost(host: string): boolean {
  if (host === '' || host.length > MAX_DSN_HOST_LEN) return false;
  let name = host;
  const lastColon = host.lastIndexOf(':');
  if (lastColon >= 0) {
    const port = host.slice(lastColon + 1);
    name = host.slice(0, lastColon);
    if (port === '' || port.length > 5 || !/^\d+$/.test(port)) return false;
    const n = Number(port);
    if (n < 1 || n > 65535) return false;
  }
  if (name === '') return false;
  if (!/^[a-zA-Z0-9.-]+$/.test(name)) return false;
  if (
    name.startsWith('.') ||
    name.endsWith('.') ||
    name.startsWith('-') ||
    name.endsWith('-')
  ) {
    return false;
  }
  return true;
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 遥测（员工面）：skill-call 与 error-reporting 上报。
 * 与 Go telemetry 对齐；可见性/限流/字段消毒均在服务层完成。
 */
@Injectable()
export class TelemetryService {
  private readonly skillCallLimiter = new SlidingWindowLimiter(60_000);
  private readonly errorReportingLimiter = new SlidingWindowLimiter(60_000);

  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async reportSkillCall(
    user: ClientPrincipal,
    body: unknown,
  ): Promise<{ ok: boolean }> {
    if (!isPlainObject(body)) {
      throw new ApiError('VALIDATION', '请求体格式错误');
    }
    const name = stripControlChars(String(body.name ?? '').trim());
    if (name === '' || name.length > MAX_NAME_LEN || name.includes('/') || name.includes('\\')) {
      throw new ApiError('VALIDATION', 'skill name 不合法');
    }
    const version = stripControlChars(String(body.version ?? '').trim());
    if (version.length > MAX_NAME_LEN) {
      throw new ApiError('VALIDATION', 'version 不合法');
    }

    const perUser = envInt('PICOAI_TELEMETRY_MAX_PER_MIN', 60);
    const perSkill = envInt('PICOAI_TELEMETRY_MAX_PER_SKILL_PER_MIN', 10);
    if (
      !this.skillCallLimiter.allow(`u:${user.userId}`, perUser) ||
      !this.skillCallLimiter.allow(`s:${user.userId}|${name}`, perSkill)
    ) {
      throw new ApiError('RATE_LIMITED', '上报过于频繁,请稍后再试', 429);
    }

    try {
      const allowed = await this.skillCallTargetAllowed(user, name);
      if (!allowed) return { ok: true }; // 不可见技能：静默 200 不持久化
      // 计数持久化：重写 schema 无 app_releases.calls 计数表，no-op（见报告）。
      return { ok: true };
    } catch {
      throw new ApiError('INTERNAL', '记录失败');
    }
  }

  async reportErrorReporting(
    user: ClientPrincipal,
    body: unknown,
  ): Promise<{ ok: boolean }> {
    if (!isPlainObject(body)) {
      throw new ApiError('VALIDATION', '请求体格式错误');
    }
    const state = stripControlChars(String(body.state ?? '').trim());
    if (!ERROR_REPORTING_STATES.has(state)) {
      return { ok: true }; // 非法 state：静默 200 不持久化
    }
    const dsnHost = String(body.dsn_host ?? '').trim();
    const level = String(body.level ?? '').trim();
    const reason = truncateRunes(stripControlChars(String(body.reason ?? '').trim()), 200);
    const release = truncateRunes(stripControlChars(String(body.release ?? '').trim()), 64);

    const limit = envInt('PICOAI_TELEMETRY_ERROR_REPORTING_MAX_PER_MIN', 10);
    if (!this.errorReportingLimiter.allow(`u:${user.userId}`, limit)) {
      throw new ApiError('RATE_LIMITED', '上报过于频繁,请稍后再试', 429);
    }

    const finalHost = validDSNHost(dsnHost) ? dsnHost : '';
    const finalLevel = ERROR_REPORTING_LEVELS.has(level) ? level : '';
    try {
      await this.db
        .insert(clientErrorReportingStatus)
        .values({
          userId: user.userId,
          state,
          reason,
          dsnHost: finalHost,
          level: finalLevel,
          release,
        })
        .onConflictDoUpdate({
          target: clientErrorReportingStatus.userId,
          set: {
            state,
            reason,
            dsnHost: finalHost,
            level: finalLevel,
            release,
            updatedAt: new Date(),
          },
        });
      return { ok: true };
    } catch {
      throw new ApiError('INTERNAL', '记录失败');
    }
  }

  /** 技能可见性：非商城技能 → 允许；管理员全量；否则按授权过滤。 */
  private async skillCallTargetAllowed(
    user: ClientPrincipal,
    name: string,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ name: skills.name })
      .from(skills)
      .where(and(eq(skills.name, name), eq(skills.enabled, 1)))
      .limit(1);
    if (rows.length === 0) return true; // 本地/内置技能：不限制
    if (user.role === 'super_admin') return true;

    const groups = await resolveUserEffectiveGroups(this.db, user.userId);
    const granted = await this.db
      .select({ skillName: skillGrants.skillName })
      .from(skillGrants)
      .where(and(granteeMatch(user.username, groups), eq(skillGrants.skillName, name)));
    return granted.length > 0;
  }
}
