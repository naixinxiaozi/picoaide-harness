import { Controller, Get, Inject, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'drizzle-orm';
import { CurrentUser, ClientPrincipal, Public } from '../common/decorators';
import { BearerAuthGuard } from '../common/guards/bearer-auth.guard';
import { DRIZZLE, type Database } from '../db/database.module';
import { BootstrapService } from './bootstrap.service';

/** 员工面引导配置（Bearer）：/api/client/v2/config/bootstrap。 */
@Controller('api/client/v2/config')
@UseGuards(BearerAuthGuard)
export class BootstrapController {
  constructor(private readonly svc: BootstrapService) {}

  @Get('bootstrap')
  bootstrap(@CurrentUser() user: ClientPrincipal): Promise<Record<string, unknown>> {
    return this.svc.build({ userId: user.userId, username: user.username, role: user.role });
  }
}

/** 健康探测（公开，根路由）：/healthz。 */
@Controller('healthz')
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  @Get()
  @Public()
  async health(@Res({ passthrough: true }) res: Response): Promise<Record<string, unknown>> {
    try {
      await this.ping(3000);
      return { ok: true };
    } catch {
      res.status(503);
      return { ok: false, error: { code: 'INTERNAL', message: 'db unavailable' } };
    }
  }

  private async ping(timeoutMs: number): Promise<void> {
    await Promise.race([
      this.db.execute(sql`SELECT 1`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('db ping timeout')), timeoutMs),
      ),
    ]);
  }
}
