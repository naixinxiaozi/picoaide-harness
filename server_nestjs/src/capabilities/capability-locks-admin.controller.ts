import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { CurrentAdmin, Permissions, type AdminPrincipal } from '../common/decorators';
import { CapabilitiesService } from './capabilities.service';

@Controller('api/server/admin/capability-locks')
@UseGuards(AdminAuthGuard, RbacGuard)
export class CapabilityLocksAdminController {
  constructor(private readonly caps: CapabilitiesService) {}

  @Get()
  @Permissions('capability:read')
  async list() {
    return { locks: await this.caps.listLocks() };
  }

  @Put(':kind/:name')
  @Permissions('capability:write')
  async lock(
    @Param('kind') kind: string,
    @Param('name') name: string,
    @Body() body: { reason?: string },
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.caps.lock(kind, name, body?.reason ?? '', admin.username);
    return { ok: true };
  }

  @Delete(':kind/:name')
  @Permissions('capability:write')
  async unlock(@Param('kind') kind: string, @Param('name') name: string) {
    await this.caps.unlock(kind, name);
    return { ok: true };
  }
}
