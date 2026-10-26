import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';

import { AdminPrincipal, CurrentAdmin, Permissions } from '../common/decorators';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';

import { AdminUsersService } from './admin-users.service';

@Controller('api/server/admin')
@UseGuards(AdminAuthGuard, RbacGuard)
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Get('users')
  @Permissions('user:read')
  list(
    @Query('page') page?: string,
    @Query('size') size?: string,
    @Query('q') q?: string,
  ) {
    return this.service.list({ page, size, q });
  }

  @Post('users')
  @HttpCode(HttpStatus.CREATED)
  @Permissions('user:write')
  create(@Body() body: Record<string, unknown>, @CurrentAdmin() admin: AdminPrincipal) {
    return this.service.create(body as never, { userId: admin.userId, username: admin.username });
  }

  @Put('users/:id')
  @Permissions('user:write')
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    return this.service.update(id, body as never, { userId: admin.userId, username: admin.username });
  }

  @Delete('users/:id')
  @Permissions('user:write')
  remove(@Param('id') id: string, @CurrentAdmin() admin: AdminPrincipal) {
    return this.service.remove(id, { userId: admin.userId, username: admin.username });
  }

  @Put('users/:id/mfa')
  @Permissions('user:write')
  resetMfa(@Param('id') id: string, @CurrentAdmin() admin: AdminPrincipal) {
    return this.service.resetMfa(id, { userId: admin.userId, username: admin.username });
  }

  @Get('users/:id/groups')
  @Permissions('user:read')
  getGroups(@Param('id') id: string) {
    return this.service.getGroups(id);
  }

  @Put('users/:id/department')
  @Permissions('dept:write')
  setDepartment(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    return this.service.setDepartment(id, body, {
      userId: admin.userId,
      username: admin.username,
    });
  }

  @Get('users/:id/tokens')
  @Permissions('user:read')
  listTokens(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('size') size?: string,
  ) {
    return this.service.listTokens(id, page, size);
  }

  @Post('tokens/:id/revoke')
  @Permissions('user:write')
  revokeToken(@Param('id') id: string) {
    return this.service.revokeToken(id);
  }
}
