import { Module } from '@nestjs/common';
import { PortalService } from './portal.service';
import { PortalController } from './portal.controller';

/** 门户配置域（管理面 GET/PUT portal）。SettingsService 由 @Global SettingsModule 提供。 */
@Module({
  providers: [PortalService],
  controllers: [PortalController],
})
export class PortalModule {}
