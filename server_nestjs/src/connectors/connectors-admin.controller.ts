import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { CurrentAdmin, Permissions, type AdminPrincipal } from '../common/decorators';
import { ConnectorsService } from './connectors.service';

@Controller('api/server/admin/connectors')
@UseGuards(AdminAuthGuard, RbacGuard)
export class ConnectorsAdminController {
  constructor(private readonly connectors: ConnectorsService) {}

  @Get()
  @Permissions('connector:read')
  async list() {
    return { connectors: await this.connectors.list() };
  }

  @Get(':id')
  @Permissions('connector:read')
  async get(@Param('id') id: string) {
    return { connector: await this.connectors.get(id) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Permissions('connector:write')
  async create(
    @Body() body: Record<string, unknown>,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    return { connector: await this.connectors.create(body, admin.username) };
  }

  @Put(':id')
  @Permissions('connector:write')
  async update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    return { connector: await this.connectors.update(id, body, admin.username) };
  }

  @Put(':id/enabled')
  @Permissions('connector:write')
  async setEnabled(
    @Param('id') id: string,
    @Body() body: { enabled?: boolean },
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.connectors.setEnabled(id, body ?? {}, admin.username);
    return { ok: true };
  }

  @Delete(':id')
  @Permissions('connector:write')
  async remove(
    @Param('id') id: string,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.connectors.remove(id, admin.username);
    return { ok: true };
  }
}
