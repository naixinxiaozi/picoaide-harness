import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/database.module';
import { CryptoService } from '../crypto/crypto.service';
import { ApiError } from '../errors/api-error';
import { adminSessions, users } from '../../db/schema';
import { IS_PUBLIC_KEY, type AdminPrincipal } from '../decorators';
import { hasManagementAccess, type AdminRole } from '../rbac/permissions';

/** 管理端会话 cookie 名（与现有 server 一致）。 */
export const ADMIN_COOKIE = 'picoaide_session';
/** CSRF 头名。 */
export const CSRF_HEADER = 'X-CSRF-Token';

const HARD_TTL_MS = 12 * 60 * 60 * 1000; // 12h 硬上限（创建时固定，不滑动）
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60min 空闲滑动
const CSRF_WINDOW_MS = 60 * 60 * 1000; // 1h 小时窗口（新旧窗口均有效）

/**
 * 管理端会话守卫（/api/server/admin 面），等价于现有 server 的 adminAuth()：
 * 会话校验 → 写操作 CSRF 校验 → 强制改密守卫。
 * 校验通过注入 req.admin 并尽力刷新 last_used_at（非致命）。
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])) {
      return true;
    }

    const req = ctx.switchToHttp().getRequest<Request>();
    const secret = readCookie(req.headers.cookie, ADMIN_COOKIE);
    if (!secret) throw new ApiError('AUTH_REQUIRED', '未登录');

    const secretHash = this.crypto.sha256(secret);
    const [row] = await this.db
      .select({ session: adminSessions, user: users })
      .from(adminSessions)
      .innerJoin(users, eq(adminSessions.userId, users.id))
      .where(eq(adminSessions.secretHash, secretHash))
      .limit(1);

    if (!row) throw new ApiError('AUTH_FAILED', '会话无效或已过期');
    if (row.session.expiresAt.getTime() < Date.now()) {
      throw new ApiError('AUTH_FAILED', '会话无效或已过期');
    }
    if (Date.now() - row.session.lastUsedAt.getTime() > IDLE_TIMEOUT_MS) {
      throw new ApiError('AUTH_FAILED', '会话无效或已过期');
    }
    if (
      !hasManagementAccess(row.user.role as AdminRole) ||
      row.user.status !== 1
    ) {
      throw new ApiError('AUTH_FAILED', '会话无效或已过期');
    }

    // 写操作 CSRF 校验（F1：失败用独立错误码 CSRF_EXPIRED，前端刷新 token 重试）。
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const token = req.headers[CSRF_HEADER.toLowerCase()];
      const ok =
        typeof token === 'string' &&
        (this.verifySessionCsrf(row.session.csrfKey, secret, token) ||
          this.verifyWindowCsrf(row.session.csrfKey, token));
      if (!ok) {
        throw new ApiError('CSRF_EXPIRED', 'CSRF 校验失败,请刷新页面重试');
      }
    }

    // 强制改密守卫：password_must_change 期间仅放行 me/logout/me/password。
    if (
      row.user.passwordMustChange === 1 &&
      !adminPasswordChangeAllowed(req.method, req.path)
    ) {
      throw new ApiError('PASSWORD_CHANGE_REQUIRED', '请先修改密码');
    }

    // 尽力而为刷新 last_used_at（非致命，不推进硬过期）。
    this.db
      .update(adminSessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(adminSessions.id, row.session.id))
      .then(
        () => undefined,
        () => undefined,
      );

    const principal: AdminPrincipal = {
      userId: row.user.id,
      username: row.user.username,
      role: row.user.role,
      sessionSecret: secret,
      csrfKey: row.session.csrfKey,
    };
    (req as Request & { admin: AdminPrincipal }).admin = principal;
    return true;
  }

  /** 会话绑定 CSRF：HMAC(csrfKey, "session:" + secret)。 */
  private verifySessionCsrf(
    csrfKey: string,
    secret: string,
    token: string,
  ): boolean {
    const expect = this.crypto.hmacSha256(csrfKey, 'session:' + secret);
    return this.crypto.constantTimeEqual(expect, token);
  }

  /** 小时窗口 CSRF：HMAC(csrfKey, window)，当前/上一窗口均有效。 */
  private verifyWindowCsrf(csrfKey: string, token: string): boolean {
    const now = Date.now();
    for (const at of [now, now - CSRF_WINDOW_MS]) {
      const window = String(
        Math.floor(Math.trunc(at / CSRF_WINDOW_MS) * CSRF_WINDOW_MS / 1000),
      );
      if (this.crypto.constantTimeEqual(this.crypto.hmacSha256(csrfKey, window), token)) {
        return true;
      }
    }
    return false;
  }
}

/** 管理面强制改密态白名单（与现有 server 一致）。 */
function adminPasswordChangeAllowed(method: string, path: string): boolean {
  if (method === 'POST' && path === '/api/server/admin/me/password') return true;
  if (method === 'GET' && path === '/api/server/admin/me') return true;
  if (method === 'POST' && path === '/api/server/admin/logout') return true;
  return false;
}

export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}
