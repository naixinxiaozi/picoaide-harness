import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { CurrentAdmin, Permissions, type AdminPrincipal } from '../common/decorators';
import { GatewayService } from './gateway.service';

@Controller('api/server/admin')
@UseGuards(AdminAuthGuard, RbacGuard)
export class GatewayAdminController {
  constructor(private readonly gateway: GatewayService) {}

  @Get('gateway')
  @Permissions('gateway:read')
  async getConfig(): Promise<unknown> {
    return this.gateway.getGatewayConfig();
  }

  @Put('gateway')
  @Permissions('gateway:write')
  @HttpCode(HttpStatus.OK)
  async setConfig(
    @CurrentAdmin() admin: AdminPrincipal,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    return this.gateway.setGatewayConfig(admin.username, body ?? {});
  }

  @Post('gateway/error-reporting/test')
  @Permissions('gateway:write')
  @HttpCode(HttpStatus.OK)
  async testErrorReporting(
    @CurrentAdmin() admin: AdminPrincipal,
    @Body() body: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    const r = await this.gateway.errorReportingTest(admin.username, body ?? {});
    res.status(r.status).json(r.payload);
  }

  @Get('gateway/error-reporting/clients')
  @Permissions('gateway:read')
  async errorReportingClients(): Promise<unknown> {
    return this.gateway.errorReportingClients();
  }

  @Get('concurrency')
  @Permissions('gateway:read')
  async concurrency(): Promise<unknown> {
    return this.gateway.concurrencyStatus();
  }
}
