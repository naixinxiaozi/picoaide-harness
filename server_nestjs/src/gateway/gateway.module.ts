import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';
import { GatewayService } from './gateway.service';
import { GatewayV1Controller, GatewayRootController } from './gateway.controller';
import { GatewayAdminController } from './gateway-admin.controller';

@Module({
  imports: [UsersModule, AuditModule],
  controllers: [GatewayV1Controller, GatewayRootController, GatewayAdminController],
  providers: [GatewayService],
  exports: [GatewayService],
})
export class GatewayModule {}
