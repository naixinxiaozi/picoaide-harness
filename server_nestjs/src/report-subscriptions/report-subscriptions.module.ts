import { Module } from '@nestjs/common';
import { UsageModule } from '../usage/usage.module';
import { AuditModule } from '../audit/audit.module';
import { ReportSubscriptionsService } from './report-subscriptions.service';
import { ReportSubscriptionsController } from './report-subscriptions.controller';

/** 报表订阅域：管理面 CRUD + 测试推送 + 月度投递（由 scheduler 调用）。 */
@Module({
  imports: [UsageModule, AuditModule],
  controllers: [ReportSubscriptionsController],
  providers: [ReportSubscriptionsService],
  exports: [ReportSubscriptionsService],
})
export class ReportSubscriptionsModule {}
