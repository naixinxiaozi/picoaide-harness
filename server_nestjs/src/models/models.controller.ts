import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { CurrentAdmin, Permissions, type AdminPrincipal } from '../common/decorators';
import { ModelsService } from './models.service';

@Controller('api/server/admin')
@UseGuards(AdminAuthGuard, RbacGuard)
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get('models')
  @Permissions('gateway:read')
  async list(): Promise<unknown> {
    return this.models.listModels();
  }

  @Post('models')
  @Permissions('gateway:write')
  async create(@CurrentAdmin() admin: AdminPrincipal, @Body() body: Record<string, unknown>): Promise<unknown> {
    return this.models.createModel(admin.username, body ?? {});
  }

  @Put('models/:id')
  @Permissions('gateway:write')
  async update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.models.updateModel(admin.username, id, body ?? {});
  }

  @Delete('models/:id')
  @Permissions('gateway:write')
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentAdmin() admin: AdminPrincipal, @Param('id', ParseIntPipe) id: number): Promise<unknown> {
    return this.models.deleteModel(admin.username, id);
  }
}
