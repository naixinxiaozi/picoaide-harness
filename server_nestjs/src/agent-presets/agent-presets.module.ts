import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AgentPresetsService } from './agent-presets.service';
import { AgentPresetsController } from './agent-presets.controller';
import { AgentPresetsAdminController } from './agent-presets-admin.controller';

@Module({
  imports: [AuditModule],
  controllers: [AgentPresetsController, AgentPresetsAdminController],
  providers: [AgentPresetsService],
  exports: [AgentPresetsService],
})
export class AgentPresetsModule {}
