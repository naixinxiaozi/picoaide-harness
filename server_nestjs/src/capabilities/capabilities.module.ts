import { Module } from '@nestjs/common';
import { CapabilitiesService } from './capabilities.service';
import { CapabilitiesController } from './capabilities.controller';
import { CapabilitiesAdminController } from './capabilities-admin.controller';
import { CapabilityLocksAdminController } from './capability-locks-admin.controller';

@Module({
  controllers: [
    CapabilitiesController,
    CapabilitiesAdminController,
    CapabilityLocksAdminController,
  ],
  providers: [CapabilitiesService],
  exports: [CapabilitiesService],
})
export class CapabilitiesModule {}
