import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { Permissions } from '../common/decorators';
import { CapabilitiesService } from './capabilities.service';

@Controller('api/server/admin/capabilities')
@UseGuards(AdminAuthGuard, RbacGuard)
export class CapabilitiesAdminController {
  constructor(private readonly caps: CapabilitiesService) {}

  @Get('approvals')
  @Permissions('capability:read')
  async approvals(
    @Query('status') status: string | undefined,
    @Query('type') type: string | undefined,
  ) {
    return { approvals: await this.caps.approvals({ status, type }) };
  }
}
