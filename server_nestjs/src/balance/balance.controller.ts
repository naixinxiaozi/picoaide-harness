import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { Permissions, CurrentAdmin, AdminPrincipal } from '../common/decorators';
import { ApiError } from '../common/errors/api-error';
import { BalanceService } from './balance.service';

interface AdjustBody {
  mode?: string;
  amount?: number | null;
  reason?: string;
}

interface BalanceSettingsBody {
  enabled?: boolean;
  monthly_amount?: number;
  monthly_mode?: string;
}

@Controller('api/server/admin')
@UseGuards(AdminAuthGuard, RbacGuard)
export class BalanceController {
  constructor(private readonly service: BalanceService) {}

  private parseUserId(raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new ApiError('VALIDATION', '非法用户 ID', 400);
    return n;
  }

  @Post('users/:id/balance')
  @Permissions('user:write')
  async adjust(
    @Param('id') id: string,
    @Body() body: AdjustBody,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    const userId = this.parseUserId(id);
    const result = await this.service.adjust(
      userId,
      body.mode ?? '',
      body.amount ?? undefined,
      body.reason ?? '',
      admin.username,
    );
    return { ok: true, ...result };
  }

  @Get('users/:id/balance/ledger')
  @Permissions('user:read')
  async ledger(
    @Param('id') id: string,
    @Query('kind') kind: string | undefined,
    @Query('page') page: string | undefined,
    @Query('size') size: string | undefined,
  ) {
    const userId = this.parseUserId(id);
    const p = Number(page ?? '1');
    const s = Number(size ?? '20');
    return this.service.ledger(userId, kind, Number.isFinite(p) ? p : 1, Number.isFinite(s) ? s : 20);
  }

  @Get('balance')
  @Permissions('user:read')
  async summary() {
    return this.service.summary();
  }

  @Put('balance')
  @Permissions('user:write')
  async putSettings(@Body() body: BalanceSettingsBody, @CurrentAdmin() admin: AdminPrincipal) {
    const result = await this.service.putSettings(
      body.enabled === true,
      Number(body.monthly_amount ?? 0),
      body.monthly_mode ?? 'add',
      admin.username,
    );
    return result;
  }

  @Post('balance/grant')
  @Permissions('user:write')
  @HttpCode(HttpStatus.OK)
  async grant(@CurrentAdmin() admin: AdminPrincipal) {
    return this.service.grant(admin.username);
  }
}
