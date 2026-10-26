import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentAdmin, Permissions, type AdminPrincipal } from '../common/decorators';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { sendArchive } from './archive-response';
import { MarketplaceService } from './marketplace.service';

/**
 * 管理面市场智能体（/api/server/admin/agents，market:read/write，channel=market）。
 * 统一应用模型：apps(kind='agent', channel='market') + app_releases + app_grants。
 */
@Controller('api/server/admin/agents')
@UseGuards(AdminAuthGuard, RbacGuard)
export class MarketplaceAdminAgentsController {
  constructor(private readonly svc: MarketplaceService) {}

  @Get()
  @Permissions('market:read')
  async listAgents(): Promise<{ agents: unknown[] }> {
    const agents = await this.svc.listAgents();
    return { agents };
  }

  @Post()
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async create(
    @Body() body: { name?: string; description?: string; author?: string },
    @CurrentAdmin() p: AdminPrincipal,
  ): Promise<{ agent: unknown }> {
    const agent = await this.svc.createAgent(body, p.username);
    return { agent };
  }

  @Post(':name/archive')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async uploadArchive(
    @Param('name') name: string,
    @Body() body: { version?: string; archive?: unknown },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    const r = await this.svc.uploadAgentArchive(name, body, p.username);
    return { ok: true, version: r.version, checksum: r.checksum };
  }

  @Put(':name')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('name') name: string,
    @Body() body: { name?: string; description?: string; author?: string },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    await this.svc.updateAgentMeta(name, body, p.username);
    return { ok: true };
  }

  @Delete(':name')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('name') name: string, @CurrentAdmin() p: AdminPrincipal) {
    await this.svc.disableAgent(name, p.username);
    return { ok: true };
  }

  @Post(':name/enable')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async enable(@Param('name') name: string, @CurrentAdmin() p: AdminPrincipal) {
    await this.svc.enableAgent(name, p.username);
    return { ok: true };
  }

  @Get(':name/preview')
  @Permissions('market:read')
  preview(@Param('name') name: string) {
    return this.svc.previewAgent(name);
  }

  @Get(':name/file')
  @Permissions('market:read')
  file(@Param('name') name: string, @Query('path') path: string) {
    return this.svc.agentFile(name, path);
  }

  @Get(':name/archive')
  @Permissions('market:read')
  async archive(@Param('name') name: string, @Res() res: Response) {
    const payload = await this.svc.downloadAgentArchive(name);
    sendArchive(res, payload, 'X-Preset');
  }

  @Get(':name/grants')
  @Permissions('market:read')
  async grants(@Param('name') name: string): Promise<{ grants: unknown[] }> {
    const grants = await this.svc.listAgentGrants(name);
    return { grants };
  }

  @Put(':name/grants')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async replaceGrants(
    @Param('name') name: string,
    @Body() body: { groups?: string[] },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    await this.svc.replaceAgentGrants(name, body?.groups, p.username);
    return { ok: true };
  }

  @Put(':name/grant')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async grant(
    @Param('name') name: string,
    @Body() body: { username?: string; group?: string },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    await this.svc.grantAgent(name, body, p.username);
    return { ok: true };
  }

  @Delete(':name/grant')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Param('name') name: string,
    @Body() body: { username?: string; group?: string },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    await this.svc.revokeAgentGrant(name, body, p.username);
    return { ok: true };
  }
}
