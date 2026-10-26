import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { AuthConfigController } from './auth-config.controller';
import { AuthConfigService } from './auth-config.service';

@Module({
  imports: [SettingsModule, AuditModule],
  controllers: [AuthConfigController],
  providers: [AuthConfigService],
  exports: [AuthConfigService],
})
export class AuthConfigModule {}
