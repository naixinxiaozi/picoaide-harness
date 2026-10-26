import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentAdmin, Public, type AdminPrincipal } from '../common/decorators';
import { ApiError } from '../common/errors/api-error';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { UsersService } from '../users/users.service';
import type { User } from '../db/schema';
import { AdminAuthService } from './admin-auth.service';

/** 管理会话 cookie 名（与现有 server 一致）。 */
export const ADMIN_COOKIE = 'picoaide_session';

function sessionCookie(secret: string, secure: boolean): string {
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(secret)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${12 * 60 * 60}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** 反代 / TLS 探测：显式配置缺省时按请求判定（与 Go secureCookieFor 默认行为一致）。 */
function requestIsSecure(req: Request): boolean {
  const fwd = req.headers['x-forwarded-proto'];
  if (fwd) return String(fwd).split(',')[0].trim() === 'https';
  return req.secure === true;
}

/**
 * 管理端认证（/api/server/admin）。login 为 public，其余走 AdminAuthGuard。
 */
@Controller('api/server/admin')
@UseGuards(AdminAuthGuard)
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly usersService: UsersService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: { username: string; password: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.auth.login(body?.username ?? '', body?.password ?? '');
    res.setHeader('Set-Cookie', sessionCookie(r.cookieValue, requestIsSecure(req)));
    return {
      csrf_token: r.csrfToken,
      user: r.user,
      must_change_password: r.mustChangePassword,
    };
  }

  @Get('me')
  async me(@CurrentAdmin() p: AdminPrincipal) {
    const user = await this.requireUser(p);
    return {
      user: this.usersService.toUserJSON(user),
      csrf_token: this.auth.csrfTokenFor(p),
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentAdmin() p: AdminPrincipal) {
    await this.auth.logout(p);
    return { ok: true };
  }

  @Post('me/password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentAdmin() p: AdminPrincipal,
    @Body() body: { old_password: string; new_password: string },
  ) {
    const user = await this.requireUser(p);
    return this.auth.changePassword(
      user,
      body?.old_password ?? '',
      body?.new_password ?? '',
    );
  }

  private async requireUser(p: AdminPrincipal): Promise<User> {
    const user = await this.usersService.findById(p.userId);
    if (!user || user.status !== 1) {
      throw new ApiError('AUTH_FAILED', '账号不存在或已禁用', 401);
    }
    return user;
  }
}
