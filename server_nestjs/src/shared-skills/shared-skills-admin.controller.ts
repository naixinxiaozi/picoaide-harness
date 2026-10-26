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
import { writeArchiveResponse } from './archive-response';
import { SharedSkillsService } from './shared-skills.service';

/** 管理面共享技能审核（/api/server/admin/shared-skills，capability:read/write，channel=org）。 */
@Controller('api/server/admin/shared-skills')
@UseGuards(AdminAuthGuard, RbacGuard)
export class SharedSkillsAdminController {
  constructor(private readonly svc: SharedSkillsService) {}

  @Get()
  @Permissions('capability:read')
  async list(@Query('status') status?: string): Promise<{ skills: unknown[] }> {
    const skills = await this.svc.listAll(status);
    return { skills };
  }

  @Get(':name/:version/archive')
  @Permissions('capability:read')
  async archive(
    @Param('name') name: string,
    @Param('version') version: string,
    @Res() res: Response,
  ): Promise<void> {
    const payload = await this.svc.download(name, version);
    writeArchiveResponse(res, payload, 'X-Skill-Version', 'X-Skill-Checksum');
  }

  @Get(':name/:version/preview')
  @Permissions('capability:read')
  preview(@Param('name') name: string, @Param('version') version: string) {
    return this.svc.preview(name, version);
  }

  @Post(':name/:version/approve')
  @Permissions('capability:write')
  @HttpCode(HttpStatus.OK)
  async approve(
    @Param('name') name: string,
    @Param('version') version: string,
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    await this.svc.approve(name, version, p.username);
    return { ok: true };
  }

  @Post(':name/:version/reject')
  @Permissions('capability:write')
  @HttpCode(HttpStatus.OK)
  async reject(
    @Param('name') name: string,
    @Param('version') version: string,
    @Body() body: { reason?: string },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    await this.svc.reject(name, version, body?.reason ?? '', p.username);
    return { ok: true };
  }

  @Delete(':name/:version')
  @Permissions('capability:write')
  @HttpCode(HttpStatus.OK)
  async remove(
    @Param('name') name: string,
    @Param('version') version: string,
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    await this.svc.deleteVersion(name, version, p.username);
    return { ok: true };
  }

  @Put(':name/:version/quality')
  @Permissions('capability:write')
  @HttpCode(HttpStatus.OK)
  async quality(
    @Param('name') name: string,
    @Param('version') version: string,
    @Body() body: { quality?: string },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    const r = await this.svc.setQuality(name, version, body?.quality ?? '', p.username);
    return { ok: true, quality: r.quality };
  }

  @Get(':name/:version/file')
  @Permissions('capability:read')
  file(
    @Param('name') name: string,
    @Param('version') version: string,
    @Query('path') path: string,
  ) {
    return this.svc.file(name, version, path);
  }

  @Get(':name/grants')
  @Permissions('capability:read')
  async grants(@Param('name') name: string): Promise<{ grants: unknown[] }> {
    const grants = await this.svc.listGrants(name);
    return { grants };
  }

  @Put(':name/grants')
  @Permissions('capability:write')
  @HttpCode(HttpStatus.OK)
  async replaceGrants(
    @Param('name') name: string,
    @Body() body: { groups?: string[] },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    await this.svc.replaceGrants(name, body?.groups, p.username);
    return { ok: true };
  }

  @Put(':name/grant')
  @Permissions('capability:write')
  @HttpCode(HttpStatus.OK)
  async grant(
    @Param('name') name: string,
    @Body() body: { username?: string; group?: string },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    await this.svc.grant(name, body, p.username);
    return { ok: true };
  }

  @Delete(':name/grant')
  @Permissions('capability:write')
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Param('name') name: string,
    @Body() body: { username?: string; group?: string },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    await this.svc.revoke(name, body, p.username);
    return { ok: true };
  }

  @Put(':name/enabled')
  @Permissions('capability:write')
  @HttpCode(HttpStatus.OK)
  async enabled(
    @Param('name') name: string,
    @Body() body: { enabled?: boolean },
    @CurrentAdmin() p: AdminPrincipal,
  ) {
    return this.svc.setEnabled(name, body, p.username);
  }
}
