import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { CurrentAdmin, Permissions, type AdminPrincipal } from '../common/decorators';
import { GatewayFilesService } from './gateway-files.service';

@Controller('api/server/admin/gateway/files')
@UseGuards(AdminAuthGuard, RbacGuard)
export class GatewayFilesAdminController {
  constructor(private readonly files: GatewayFilesService) {}

  @Get()
  @Permissions('gateway:read')
  async list(@Query() query: Record<string, unknown>): Promise<unknown> {
    return this.files.listGatewayFiles(query ?? {});
  }

  @Get('summary')
  @Permissions('gateway:read')
  async summary(@Query() query: Record<string, unknown>): Promise<unknown> {
    return this.files.gatewayFilesSummary(query ?? {});
  }

  @Delete(':file_id')
  @Permissions('gateway:write')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentAdmin() admin: AdminPrincipal, @Param('file_id') fileId: string): Promise<unknown> {
    return this.files.deleteGatewayFile(admin.username, fileId);
  }

  @Post('purge')
  @Permissions('gateway:write')
  @HttpCode(HttpStatus.OK)
  async purge(@CurrentAdmin() admin: AdminPrincipal, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.files.purgeGatewayFiles(admin.username, body ?? {});
  }
}
