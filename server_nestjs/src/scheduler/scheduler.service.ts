import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { BalanceService } from '../balance/balance.service';
import { ReportSubscriptionsService } from '../report-subscriptions/report-subscriptions.service';
import { AuditAdminService } from '../audit/audit-admin.service';
import { env } from '../config/env';

/**
 * 轻量后台调度器（无 @nestjs/schedule，用 setInterval + 生命周期钩子）：
 * - 余额月度发放：启动即跑一次，之后每 10min（幂等锚 balance_grant_items）。
 * - 报表订阅投递：启动即跑一次，之后每 1h（PG advisory lock + 两阶段）。
 * - 审计保留清理：启动即跑一次，之后每 6h（保留天数 ≤0 → 180）。
 *
 * `SCHEDULER_ENABLED=false` 可整体关闭（只读副本 / 本地排障时用）。
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private static readonly BALANCE_INTERVAL_MS = 10 * 60_000;
  private static readonly REPORT_INTERVAL_MS = 60 * 60_000;
  private static readonly RETENTION_INTERVAL_MS = 6 * 60 * 60_000;

  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly balance: BalanceService,
    private readonly reports: ReportSubscriptionsService,
    private readonly auditAdmin: AuditAdminService,
  ) {}

  onApplicationBootstrap(): void {
    if (env('SCHEDULER_ENABLED', 'true') === 'false') return;

    void this.runBalance();
    this.timers.push(setInterval(() => void this.runBalance(), SchedulerService.BALANCE_INTERVAL_MS));

    void this.runReports();
    this.timers.push(setInterval(() => void this.runReports(), SchedulerService.REPORT_INTERVAL_MS));

    void this.runRetention();
    this.timers.push(
      setInterval(() => void this.runRetention(), SchedulerService.RETENTION_INTERVAL_MS),
    );
  }

  onApplicationShutdown(_signal?: string): void {
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  private async runBalance(): Promise<void> {
    try {
      const s = await this.balance.getSettings();
      if (s.monthly_amount <= 0) return;
      await this.balance.grant('system');
    } catch (e) {
      console.error('[scheduler] balance grant failed:', e instanceof Error ? e.message : e);
    }
  }

  private async runReports(): Promise<void> {
    try {
      const { ok, failed } = await this.reports.dispatchDue(new Date());
      if (failed > 0) {
        console.error(`[scheduler] reports monthly dispatch done (ok=${ok} failed=${failed})`);
      }
    } catch (e) {
      console.error('[scheduler] reports dispatch failed:', e instanceof Error ? e.message : e);
    }
  }

  private async runRetention(): Promise<void> {
    try {
      const { retention_days } = await this.auditAdmin.getRetention();
      const removed = await this.auditAdmin.purgeOld(retention_days);
      if (removed > 0) {
        console.log(
          `[scheduler] audit retention: purged ${removed} audit entr(ies) (retention_days=${retention_days})`,
        );
      }
    } catch (e) {
      console.error('[scheduler] audit retention failed:', e instanceof Error ? e.message : e);
    }
  }
}
