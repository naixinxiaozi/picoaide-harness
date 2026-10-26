import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { GatewayFilesService } from './gateway-files.service';
import { GatewayFilesV1Controller, GatewayFilesRootController } from './gateway-files.controller';
import { GatewayFilesAdminController } from './gateway-files-admin.controller';

@Module({
  imports: [AuditModule],
  controllers: [GatewayFilesV1Controller, GatewayFilesRootController, GatewayFilesAdminController],
  providers: [GatewayFilesService],
  exports: [GatewayFilesService],
})
export class GatewayFilesModule {}
