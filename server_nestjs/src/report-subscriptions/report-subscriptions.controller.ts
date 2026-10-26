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
import { CurrentAdmin, AdminPrincipal, Permissions } from '../common/decorators';
import { ReportSubscriptionsService } from './report-subscriptions.service';

/** 管理面报表订阅（AdminAuth + RBAC）。 */
@Controller('api/server/admin/report-subscriptions')
@UseGuards(AdminAuthGuard, RbacGuard)
export class ReportSubscriptionsController {
  constructor(private readonly svc: ReportSubscriptionsService) {}

  @Get()
  @Permissions('report:read')
  list() {
    return this.svc.list();
  }

  @Post()
  @Permissions('report:write')
  create(@CurrentAdmin() admin: AdminPrincipal, @Body() body: unknown) {
    return this.svc.create(admin.username, body);
  }

  @Put(':id')
  @Permissions('report:write')
  update(
    @CurrentAdmin() admin: AdminPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.svc.update(admin.username, id, body);
  }

  @Delete(':id')
  @Permissions('report:write')
  remove(@CurrentAdmin() admin: AdminPrincipal, @Param('id') id: string) {
    return this.svc.remove(admin.username, id);
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @Permissions('report:write')
  testPush(@Param('id') id: string) {
    return this.svc.testPush(id);
  }
}
