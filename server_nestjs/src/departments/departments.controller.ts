import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { Permissions, CurrentAdmin, AdminPrincipal } from '../common/decorators';
import { DepartmentsService, DeptBody } from './departments.service';

@Controller('api/server/admin')
@UseGuards(AdminAuthGuard, RbacGuard)
export class DepartmentsController {
  constructor(private readonly service: DepartmentsService) {}

  @Get('departments')
  @Permissions('dept:read')
  async list() {
    const departments = await this.service.list();
    return { departments };
  }

  @Post('departments')
  @Permissions('dept:write')
  async create(@Body() body: DeptBody, @CurrentAdmin() admin: AdminPrincipal) {
    const department = await this.service.create(body, admin.username);
    return { department };
  }

  @Put('departments/:id')
  @Permissions('dept:write')
  async update(
    @Param('id') id: string,
    @Body() body: DeptBody,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    const department = await this.service.update(id, body, admin.username);
    return { department };
  }

  @Delete('departments/:id')
  @Permissions('dept:write')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id') id: string, @CurrentAdmin() admin: AdminPrincipal) {
    await this.service.remove(id, admin.username);
    return { ok: true };
  }
}
