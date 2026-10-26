import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './db/database.module';
import { CommonModule } from './common/common.module';
import { DatabaseService } from './db/database.service';
import { UsersModule } from './users/users.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { SettingsModule } from './settings/settings.module';
import { AdminAuthModule } from './admin-auth/admin-auth.module';
import { AdminUsersModule } from './admin-users/admin-users.module';
import { AgentPresetsModule } from './agent-presets/agent-presets.module';
import { AuthConfigModule } from './auth-config/auth-config.module';
import { BalanceModule } from './balance/balance.module';
import { BootstrapModule } from './bootstrap/bootstrap.module';
import { CapabilitiesModule } from './capabilities/capabilities.module';
import { ChannelModule } from './channel/channel.module';
import { ClientReleaseModule } from './client-release/client-release.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { DepartmentsModule } from './departments/departments.module';
import { GatewayModule } from './gateway/gateway.module';
import { GatewayFilesModule } from './gateway-files/gateway-files.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { ModelsModule } from './models/models.module';
import { PortalModule } from './portal/portal.module';
import { ProvidersModule } from './providers/providers.module';
import { ReportSubscriptionsModule } from './report-subscriptions/report-subscriptions.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { ServerInfoModule } from './server-info/server-info.module';
import { SharedSkillsModule } from './shared-skills/shared-skills.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { UsageModule } from './usage/usage.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CommonModule,
    SettingsModule,
    UsersModule,
    AuditModule,
    AuthModule,
    AdminAuthModule,
    AdminUsersModule,
    AgentPresetsModule,
    AuthConfigModule,
    BalanceModule,
    BootstrapModule,
    CapabilitiesModule,
    ChannelModule,
    ClientReleaseModule,
    ConnectorsModule,
    DepartmentsModule,
    GatewayModule,
    GatewayFilesModule,
    MarketplaceModule,
    ModelsModule,
    PortalModule,
    ProvidersModule,
    ReportSubscriptionsModule,
    SchedulerModule,
    ServerInfoModule,
    SharedSkillsModule,
    TelemetryModule,
    UsageModule,
  ],
  providers: [DatabaseService],
})
export class AppModule {}
