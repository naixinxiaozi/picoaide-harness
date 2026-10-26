import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { CryptoService } from '../common/crypto/crypto.service';
import { ApiError } from '../common/errors/api-error';
import { quantizeMoney } from '../common/money';
import {
  beijingDayStartUTC,
  beijingMonthStartUTC,
  beijingParts,
} from '../common/time';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { settings, usage, users, type User } from '../db/schema';
import { TokenService } from './token.service';

const MAX_USERNAME_BYTES = 128;
const MAX_PASSWORD_LEN = 1024;

/**
 * 客户端员工面认证服务（/api/client/v2/auth）。
 * 本地认证全量实现；LDAP/OIDC/OpenID 为后续模块（settings 驱动的 browser provider）。
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly usersService: UsersService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async login(
    username: string,
    password: string,
    ip: string,
  ): Promise<{ token: string; user: unknown; must_change_password: boolean }> {
    if (!username) throw new ApiError('VALIDATION', '请求体格式错误', 400);
    if (
      Buffer.byteLength(username, 'utf8') > MAX_USERNAME_BYTES ||
      password.length > MAX_PASSWORD_LEN
    ) {
      throw new ApiError('VALIDATION', '用户名或密码过长', 400);
    }

    const user = await this.usersService.findByUsername(username);
    const ok =
      user && user.source === 'local'
        ? await this.crypto.verifyPassword(user.passwordHash ?? '', password)
        : false;
    if (!user || !ok) {
      await this.audit.log(username, 'login_fail', `ip=${ip}`);
      throw new ApiError('AUTH_FAILED', '用户名或密码错误', 401);
    }
    if (user.status !== 1) {
      throw new ApiError('AUTH_FAILED', '账号已禁用', 401);
    }
    if (user.role === 'auditor') {
      throw new ApiError(
        'AUDITOR_NOT_ALLOWED',
        '审计账号不可登录客户端,请使用管理后台',
        401,
      );
    }

    const token = await this.tokens.issueToken(user.id);
    await this.audit.log(user.username, 'login_success', `ip=${ip}`);
    return {
      token,
      user: this.usersService.toUserJSON(user),
      must_change_password: user.passwordMustChange === 1,
    };
  }

  async logout(rawToken: string): Promise<{ ok: boolean }> {
    await this.tokens.revokeToken(rawToken);
    return { ok: true };
  }

  async changePassword(
    user: User,
    oldPassword: string,
    newPassword: string,
  ): Promise<{ ok: boolean }> {
    if (oldPassword.length > MAX_PASSWORD_LEN || newPassword.length > MAX_PASSWORD_LEN) {
      throw new ApiError('VALIDATION', '密码过长', 400);
    }
    if (user.source !== 'local' || !user.passwordHash) {
      throw new ApiError('VALIDATION', '外部认证账号不能修改密码', 400);
    }
    const ok = await this.crypto.verifyPassword(user.passwordHash, oldPassword);
    if (!ok) throw new ApiError('AUTH_FAILED', '旧密码错误', 401);

    const hash = await this.crypto.hashPassword(newPassword);
    await this.db
      .update(users)
      .set({
        passwordHash: hash,
        passwordMustChange: 0,
        passwordChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    // 改密后吊销该用户全部 token（含当前），客户端须重新登录。
    await this.tokens.revokeAllForUser(user.id);
    await this.audit.log(user.username, 'password_change', 'self');
    return { ok: true };
  }

  async usageSummary(user: User) {
    const rows = await this.db
      .select()
      .from(settings)
      .where(
        inArray(settings.key, [
          'balance.enabled',
          'balance.monthly_amount',
          'balance.monthly_mode',
        ]),
      );
    const map = new Map(rows.map((r) => [r.key, r.value ?? '']));
    const enabledRaw = map.get('balance.enabled')?.trim() ?? '';
    const balanceEnabled = enabledRaw === 'true' || enabledRaw === '1';
    const balanceMonthly = parseFloat(map.get('balance.monthly_amount') ?? '0') || 0;
    const balanceMode = map.get('balance.monthly_mode') ?? 'add';

    const now = new Date();
    const p = beijingParts(now);
    const monthStart = beijingMonthStartUTC(p.year, p.month);
    const todayStart = beijingDayStartUTC(p.year, p.month, p.day);
    const tomorrowStart = new Date(todayStart.getTime() + 86_400_000);
    const yp = beijingParts(new Date(now.getTime() - 86_400_000));
    const yesterdayStart = beijingDayStartUTC(yp.year, yp.month, yp.day);

    const [monthly, today, yesterday, total] = await Promise.all([
      this.sumUsage(user.id, monthStart, null),
      this.sumUsage(user.id, todayStart, tomorrowStart),
      this.sumUsage(user.id, yesterdayStart, todayStart),
      this.sumUsage(user.id, null, null),
    ]);

    return {
      balance_money: quantizeMoney(user.balanceMoney),
      balance_activated: user.balanceActivatedAt != null,
      balance_enabled: balanceEnabled,
      balance_monthly: balanceMonthly,
      balance_mode: balanceMode,
      is_admin: user.isAdmin === 1,
      monthly_usage: monthly.tokens,
      monthly_cost: monthly.cost,
      today_usage: today.tokens,
      today_cost: today.cost,
      yesterday_usage: yesterday.tokens,
      yesterday_cost: yesterday.cost,
      total_usage: total.tokens,
      total_cost: total.cost,
    };
  }

  private async sumUsage(
    userId: number,
    from: Date | null,
    to: Date | null,
  ): Promise<{ tokens: number; cost: number }> {
    const conds = [eq(usage.userId, userId)];
    if (from) conds.push(gte(usage.createdAt, from));
    if (to) conds.push(lt(usage.createdAt, to));
    const [row] = await this.db
      .select({
        tokens: sql<number>`coalesce(sum(prompt_tokens + completion_tokens)::float8, 0)`,
        cost: sql<number>`coalesce(sum(cost), 0)`,
      })
      .from(usage)
      .where(and(...conds));
    return {
      tokens: Number(row?.tokens ?? 0),
      cost: Number(row?.cost ?? 0),
    };
  }

  async authMethods() {
    const rows = await this.db.select().from(settings);
    const s = new Map(rows.map((r) => [r.key, r.value ?? '']));
    const get = (k: string): string => s.get(k)?.trim() ?? '';

    const enabledRaw = get('auth.enabled');
    let methods: string[];
    if (enabledRaw !== '') {
      methods = enabledRaw
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    } else {
      switch (get('auth.mode')) {
        case 'ldap':
        case 'both':
          methods = ['local', 'ldap'];
          break;
        case 'oidc':
          methods = ['local', 'oidc'];
          break;
        case 'openid':
          methods = ['local', 'openid'];
          break;
        default:
          methods = ['local'];
      }
    }
    if (!methods.includes('local')) methods = ['local', ...methods];

    const hideLocal = get('auth.hide_local') === 'true';
    const ldapConfigured =
      get('ldap.server_url') !== '' &&
      get('ldap.base_dn') !== '' &&
      get('ldap.bind_dn') !== '';
    const browserConfigured = (prefix: string): boolean =>
      get(`${prefix}.issuer`) !== '' &&
      get(`${prefix}.client_id`) !== '' &&
      get(`${prefix}.redirect_url`) !== '';

    return {
      methods: methods.map((name) => ({
        name,
        configured:
          name === 'local'
            ? true
            : name === 'ldap'
              ? ldapConfigured
              : browserConfigured(name),
        browser: name === 'openid' || name === 'oidc',
        hidden: name === 'local' && hideLocal,
      })),
    };
  }
}
