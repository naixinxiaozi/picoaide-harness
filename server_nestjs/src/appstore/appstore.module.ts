import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AppstoreAdminController } from './appstore-admin.controller';

/** 统一应用模型管理面（归属转移/官方归属）。 */
@Module({
  imports: [AuditModule],
  controllers: [AppstoreAdminController],
})
export class AppstoreModule {}
