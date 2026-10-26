import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditAdminService } from './audit-admin.service';
import { AuditAdminController } from './audit-admin.controller';

/** 审计域：写审计（AuditService.log）+ 管理面（列表/保留天数/清理）。 */
@Module({
  providers: [AuditService, AuditAdminService],
  controllers: [AuditAdminController],
  exports: [AuditService, AuditAdminService],
})
export class AuditModule {}
