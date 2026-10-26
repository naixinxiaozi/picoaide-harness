import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { Permissions } from '../common/decorators';
import { UsageService } from './usage.service';

@Controller('api/server/admin')
@UseGuards(AdminAuthGuard, RbacGuard)
export class UsageController {
  constructor(private readonly service: UsageService) {}

  @Get('usage')
  @Permissions('usage:read')
  async usage(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('group') group: string | undefined,
    @Query('username') username: string | undefined,
    @Query('dept') dept: string | undefined,
    @Query('model') model: string | undefined,
    @Query('kind') kind: string | undefined,
  ) {
    return this.service.aggregate(from, to, group ?? 'day', { username, dept, model, kind });
  }

  @Get('usage/overview')
  @Permissions('usage:read')
  async overview() {
    return this.service.overview();
  }

  @Get('usage/requests')
  @Permissions('usage:read')
  async requests(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('username') username: string | undefined,
    @Query('model') model: string | undefined,
    @Query('kind') kind: string | undefined,
    @Query('page') page: string | undefined,
    @Query('size') size: string | undefined,
  ) {
    return this.service.requests(from, to, username, model, kind, page, size);
  }
}
