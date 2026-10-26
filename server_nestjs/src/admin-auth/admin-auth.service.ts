import { Inject, Injectable } from '@nestjs/common';
import { eq, lt } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { CryptoService } from '../common/crypto/crypto.service';
import { ApiError } from '../common/errors/api-error';
import type { AdminPrincipal } from '../common/decorators';
import { hasManagementAccess, type AdminRole } from '../common/rbac/permissions';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { SettingsService } from '../settings/settings.service';
import { TokenService } from '../auth/token.service';
import { adminSessions, users, type User } from '../db/schema';

const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h 硬上限
const MAX_PASSWORD_LEN = 1024;

export interface AdminLoginResult {
  cookieValue: string;
  csrfToken: string;
  user: unknown;
  mustChangePassword: boolean;
}

/**
 * 管理端认证服务（/api/server/admin）。会话 cookie 值 = secret（randomHex(24)），
 * 库中仅存 SHA-256 哈希（P2-2）。CSRF = HMAC-SHA256(csrfKey, "session:" + secret)。
 */
@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly usersService: UsersService,
    private readonly tokens: TokenService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async login(username: string, password: string): Promise<AdminLoginResult> {
    if (!username) throw new ApiError('VALIDATION', '请求体格式错误', 400);

    const user = await this.usersService.findByUsername(username);
    const ok =
      user && user.source === 'local' && user.status === 1
        ? await this.crypto.verifyPassword(user.passwordHash ?? '', password)
        : false;
    if (
      !user ||
      !ok ||
      user.status !== 1 ||
      !hasManagementAccess(user.role as AdminRole)
    ) {
      throw new ApiError('AUTH_FAILED', '用户名或密码错误或非管理员', 401);
    }

    const { secret, csrfToken } = await this.createSession(user.id);
    return {
      cookieValue: secret,
      csrfToken,
      user: this.usersService.toUserJSON(user),
      mustChangePassword: user.passwordMustChange === 1,
    };
  }

  /** 返回当前会话的 CSRF token（管理页刷新后可直接续用）。 */
  csrfTokenFor(p: AdminPrincipal): string {
    return this.crypto.hmacSha256(p.csrfKey, 'session:' + p.sessionSecret);
  }

  async logout(p: AdminPrincipal): Promise<void> {
    await this.db
      .delete(adminSessions)
      .where(eq(adminSessions.secretHash, this.crypto.sha256(p.sessionSecret)));
  }

  async changePassword(
    user: User,
    oldPassword: string,
    newPassword: string,
  ): Promise<{ ok: boolean }> {
    if (oldPassword.length > MAX_PASSWORD_LEN || newPassword.length > MAX_PASSWORD_LEN) {
      throw new ApiError('VALIDATION', '密码过长', 400);
    }
    const minLength = await this.settings.authMinPasswordLength();
    if ([...newPassword].length < minLength) {
      throw new ApiError('VALIDATION', `密码至少 ${minLength} 位`, 400);
    }
    if (user.source !== 'local' || !user.passwordHash) {
      throw new ApiError(
        'VALIDATION',
        '外部认证用户的密码由企业 IdP 管理,不能在此修改',
        400,
      );
    }
    const matched = await this.crypto.verifyPassword(user.passwordHash, oldPassword);
    if (!matched) throw new ApiError('AUTH_FAILED', '原密码错误', 401);
    if (await this.crypto.verifyPassword(user.passwordHash, newPassword)) {
      throw new ApiError('VALIDATION', '新密码不能与原密码相同', 400);
    }

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
    await this.tokens.revokeAllForUser(user.id);
    await this.audit.log(user.username, 'admin_password_change', 'self');
    return { ok: true };
  }

  /** 建管理会话并返回 { secret(cookie 值), csrfToken }；顺带清扫过期行。 */
  private async createSession(
    userId: number,
  ): Promise<{ secret: string; csrfToken: string }> {
    const secret = this.crypto.randomHex(24);
    const csrfKey = this.crypto.randomHex(24);
    const rowId = this.crypto.randomHex(24);
    const now = new Date();

    await this.db
      .delete(adminSessions)
      .where(lt(adminSessions.expiresAt, now));

    await this.db.insert(adminSessions).values({
      id: rowId,
      userId,
      csrfKey,
      secretHash: this.crypto.sha256(secret),
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_MS),
    });

    return { secret, csrfToken: this.crypto.hmacSha256(csrfKey, 'session:' + secret) };
  }
}
