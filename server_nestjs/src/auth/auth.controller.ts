import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, Public, type ClientPrincipal } from '../common/decorators';
import { ApiError } from '../common/errors/api-error';
import { BearerAuthGuard, extractBearer } from '../common/guards/bearer-auth.guard';
import { UsersService } from '../users/users.service';
import type { User } from '../db/schema';
import { AuthService } from './auth.service';

/**
 * 客户端员工面认证（/api/client/v2/auth）。
 * 注意：oidc/openid 的 browser 登录路由（/oidc/login|callback 等）待 LDAP/OIDC
 * 模块实现后按 provider 注册表动态挂载，与 Go registerBrowserProviders 同构。
 */
@Controller('api/client/v2/auth')
@UseGuards(BearerAuthGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body() body: { username: string; password: string },
    @Req() req: Request,
  ) {
    return this.auth.login(
      body?.username ?? '',
      body?.password ?? '',
      req.ip ?? '',
    );
  }

  @Public()
  @Get('methods')
  methods() {
    return this.auth.authMethods();
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Req() req: Request) {
    return this.auth.logout(extractBearer(req.headers.authorization) ?? '');
  }

  @Get('me')
  async me(@CurrentUser() p: ClientPrincipal) {
    const user = await this.requireUser(p);
    return { user: this.usersService.toUserJSON(user) };
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() p: ClientPrincipal,
    @Body() body: { old_password: string; new_password: string },
  ) {
    const user = await this.requireUser(p);
    return this.auth.changePassword(
      user,
      body?.old_password ?? '',
      body?.new_password ?? '',
    );
  }

  @Get('usage')
  async usage(@CurrentUser() p: ClientPrincipal) {
    const user = await this.requireUser(p);
    return this.auth.usageSummary(user);
  }

  private async requireUser(p: ClientPrincipal): Promise<User> {
    const user = await this.usersService.findById(p.userId);
    if (!user || user.status !== 1) {
      throw new ApiError('AUTH_FAILED', '账号不存在或已禁用', 401);
    }
    return user;
  }
}
