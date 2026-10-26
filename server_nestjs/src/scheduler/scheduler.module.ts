import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { ReportSubscriptionsModule } from '../report-subscriptions/report-subscriptions.module';
import { AuditModule } from '../audit/audit.module';
import { SchedulerService } from './scheduler.service';

/** 后台调度器（余额/报表/审计保留），由父模块装配。 */
@Module({
  imports: [BalanceModule, ReportSubscriptionsModule, AuditModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
