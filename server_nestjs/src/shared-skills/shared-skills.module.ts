import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SharedSkillsService } from './shared-skills.service';
import { SharedSkillsController } from './shared-skills.controller';
import { SharedSkillsAdminController } from './shared-skills-admin.controller';

/** 共享技能域：员工面上传/分发 + 管理面审核/授权。 */
@Module({
  imports: [AuditModule],
  providers: [SharedSkillsService],
  controllers: [SharedSkillsController, SharedSkillsAdminController],
  exports: [SharedSkillsService],
})
export class SharedSkillsModule {}
