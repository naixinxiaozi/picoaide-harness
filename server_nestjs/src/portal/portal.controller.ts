import {
  Body,
  Controller,
  Get,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Permissions } from '../common/decorators';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { ApiError } from '../common/errors/api-error';
import { PortalService, type PortalUpdate } from './portal.service';

/**
 * 管理面门户配置（/api/server/admin/portal，portal:read/write）。
 */
@Controller('api/server/admin/portal')
@UseGuards(AdminAuthGuard, RbacGuard)
export class PortalController {
  constructor(private readonly svc: PortalService) {}

  @Get()
  @Permissions('portal:read')
  async get() {
    return this.svc.response(await this.svc.loadConfig());
  }

  @Put()
  @Permissions('portal:write')
  async put(@Body() body: PortalUpdate) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError('VALIDATION', '门户配置格式不正确');
    }
    try {
      await this.svc.saveConfig(body);
    } catch {
      throw new ApiError('INTERNAL', '门户配置保存失败');
    }
    return this.svc.response(await this.svc.loadConfig());
  }
}
