import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { CurrentAdmin, Permissions, type AdminPrincipal } from '../common/decorators';
import { ProvidersService } from './providers.service';

@Controller('api/server/admin')
@UseGuards(AdminAuthGuard, RbacGuard)
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get('providers')
  @Permissions('gateway:read')
  async list(): Promise<unknown> {
    return this.providers.listProviders();
  }

  @Post('providers')
  @Permissions('gateway:write')
  async create(@CurrentAdmin() admin: AdminPrincipal, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.providers.createProvider(admin.username, body ?? {});
  }

  @Put('providers/:id')
  @Permissions('gateway:write')
  async update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.providers.updateProvider(admin.username, id, body ?? {});
  }

  @Delete('providers/:id')
  @Permissions('gateway:write')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.providers.deleteProvider(admin.username, id);
  }

  @Get('providers/:id/balance')
  @Permissions('gateway:read')
  async balance(@Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.providers.providerBalance(id);
  }

  @Post('providers/sync-all')
  @Permissions('gateway:write')
  @HttpCode(HttpStatus.OK)
  async syncAll(): Promise<unknown> {
    return this.providers.syncAll();
  }

  @Post('providers/:id/sync')
  @Permissions('gateway:write')
  @HttpCode(HttpStatus.OK)
  async syncOne(@Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.providers.syncProviderByName(id);
  }

  @Get('channels')
  @Permissions('gateway:read')
  async channels(): Promise<unknown> {
    return this.providers.listChannels();
  }
}
