import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { Permissions } from '../common/decorators';
import { ServerInfoService } from './server-info.service';

@Controller('api/server/admin')
@UseGuards(AdminAuthGuard, RbacGuard)
export class ServerInfoController {
  constructor(private readonly info: ServerInfoService) {}

  @Get('server-info')
  @Permissions('server-info:read')
  async serverInfo(): Promise<Record<string, unknown>> {
    return this.info.collect();
  }
}
