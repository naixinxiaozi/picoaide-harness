import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ConnectorsService } from './connectors.service';
import { ConnectorsAdminController } from './connectors-admin.controller';

@Module({
  imports: [AuditModule],
  controllers: [ConnectorsAdminController],
  providers: [ConnectorsService],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
