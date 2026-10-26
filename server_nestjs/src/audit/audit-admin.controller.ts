import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { CurrentAdmin, AdminPrincipal, Permissions } from '../common/decorators';
import { roleHas, type AdminRole } from '../common/rbac/permissions';
import { AuditAdminService } from './audit-admin.service';

/** 管理面审计（AdminAuth + RBAC）。 */
@Controller('api/server/admin/audit')
@UseGuards(AdminAuthGuard, RbacGuard)
export class AuditAdminController {
  constructor(private readonly svc: AuditAdminService) {}

  @Get()
  @Permissions('audit:read')
  list(
    @CurrentAdmin() admin: AdminPrincipal,
    @Query('page') page?: string,
    @Query('size') size?: string,
    @Query('action') action?: string,
    @Query('username') username?: string,
  ) {
    return this.svc.list(page, size, action, username, roleHas(admin.role as AdminRole, 'report:read'));
  }

  @Get('settings')
  @Permissions('audit:read')
  getRetention() {
    return this.svc.getRetention();
  }

  @Put('settings')
  @Permissions('audit:retention:write')
  setRetention(
    @CurrentAdmin() admin: AdminPrincipal,
    @Body() body: { retention_days?: number | null },
  ) {
    return this.svc.setRetention(body?.retention_days, admin.username);
  }
}
