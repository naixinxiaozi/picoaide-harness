import { Module } from '@nestjs/common';
import { BootstrapService } from './bootstrap.service';
import { BootstrapController, HealthController } from './bootstrap.controller';

/** 引导配置域：/api/client/v2/config/bootstrap + /healthz。 */
@Module({
  providers: [BootstrapService],
  controllers: [BootstrapController, HealthController],
  exports: [BootstrapService],
})
export class BootstrapModule {}
