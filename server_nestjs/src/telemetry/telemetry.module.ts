import { Module } from '@nestjs/common';
import { TelemetryService } from './telemetry.service';
import { TelemetryController } from './telemetry.controller';

/** 遥测域：员工面 skill-call / error-reporting 上报（管理面错误上报查询由 gateway 域负责）。 */
@Module({
  providers: [TelemetryService],
  controllers: [TelemetryController],
  exports: [TelemetryService],
})
export class TelemetryModule {}
