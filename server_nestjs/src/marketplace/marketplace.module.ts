import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MarketplaceService } from './marketplace.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceAdminSkillsController } from './marketplace-admin-skills.controller';
import { MarketplaceAdminAgentsController } from './marketplace-admin-agents.controller';

/** 技能商城域：员工面 marketplace/builtin + 管理面 skills/agents。 */
@Module({
  imports: [AuditModule],
  providers: [MarketplaceService],
  controllers: [
    MarketplaceController,
    MarketplaceAdminSkillsController,
    MarketplaceAdminAgentsController,
  ],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
