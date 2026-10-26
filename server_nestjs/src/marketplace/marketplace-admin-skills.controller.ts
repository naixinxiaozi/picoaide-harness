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
  UseGuards,
} from '@nestjs/common';
import { CurrentAdmin, Permissions, type AdminPrincipal } from '../common/decorators';
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { MarketplaceService } from './marketplace.service';

/**
 * 管理面商城技能（/api/server/admin/skills，market:read/write，channel=market）。
 * 内置技能诊断挂在 /skills/builtin（capability:read）。
 */
@Controller('api/server/admin/skills')
@UseGuards(AdminAuthGuard, RbacGuard)
export class MarketplaceAdminSkillsController {
  constructor(private readonly svc: MarketplaceService) {}

  @Get()
  @Permissions('market:read')
  async listSkills(): Promise<{ skills: unknown[] }> {
    const skills = await this.svc.listSkills();
    return { skills };
  }

  @Post()
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async create(@Body() body: Record<string, unknown>): Promise<{ skill: unknown }> {
    const skill = await this.svc.createSkill(body as never);
    return { skill };
  }

  @Post(':name/archive')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async uploadArchive(
    @Param('name') name: string,
    @Body() body: { version?: string; archive?: unknown },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    const r = await this.svc.uploadSkillArchive(name, body, p.username);
    return { ok: true, version: r.version, checksum: r.checksum };
  }

  @Put(':name')
  @Permissions('market:write')
  async update(
    @Param('name') name: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ skill: unknown }> {
    const skill = await this.svc.updateSkillMeta(name, body as never);
    return { skill };
  }

  @Delete(':name')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('name') name: string, @CurrentAdmin() p: AdminPrincipal) {
    await this.svc.disableSkill(name, p.username);
    return { ok: true };
  }

  @Post(':name/enable')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  async enable(@Param('name') name: string, @CurrentAdmin() p: AdminPrincipal) {
    await this.svc.enableSkill(name, p.username);
    return { ok: true };
  }

  @Get(':name/preview')
  @Permissions('market:read')
  preview(@Param('name') name: string) {
    return this.svc.previewSkill(name);
  }

  @Get(':name/file')
  @Permissions('market:read')
  file(@Param('name') name: string, @Query('path') path: string) {
    return this.svc.skillFile(name, path);
  }

  @Get(':name/archive')
  @Permissions('market:read')
  archive(@Param('name') name: string) {
    return this.svc.downloadSkillArchive(name);
  }

  @Post(':name/normalize')
  @Permissions('market:write')
  @HttpCode(HttpStatus.OK)
  normalize(@Param('name') name: string) {
    return this.svc.normalizeSkill(name).then((r) => ({ ok: true, ...r }));
  }

  @Get(':name/grants')
  @Permissions('market:read')
  async grants(@Param('name') name: string): Promise<{ grants: unknown[] }> {
    const grants = await this.svc.listSkillGrants(name);
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
    await this.svc.replaceSkillGrants(name, body?.groups, p.username);
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
    await this.svc.grantSkill(name, body, p.username);
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
    await this.svc.revokeSkillGrant(name, body, p.username);
    return { ok: true };
  }

  @Get('builtin')
  @Permissions('capability:read')
  builtin() {
    return this.svc.builtinDiagnostic();
  }
}
