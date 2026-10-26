import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { Permissions, CurrentAdmin, AdminPrincipal } from '../common/decorators';
import { AuthConfigService, AuthConfigBody, AuthTestBody } from './auth-config.service';

@Controller('api/server/admin')
@UseGuards(AdminAuthGuard, RbacGuard)
export class AuthConfigController {
  constructor(private readonly service: AuthConfigService) {}

  @Get('auth')
  @Permissions('auth:read')
  async get() {
    return { auth: await this.service.getConfig() };
  }

  @Put('auth')
  @Permissions('auth:write')
  async put(@Body() body: AuthConfigBody, @CurrentAdmin() admin: AdminPrincipal) {
    await this.service.setConfig(body, admin.username);
    return { ok: true };
  }

  @Post('auth/test')
  @Permissions('auth:write')
  @HttpCode(HttpStatus.OK)
  async test(@Body() body: AuthTestBody) {
    return this.service.test(body);
  }
}
