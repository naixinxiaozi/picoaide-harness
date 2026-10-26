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
import { AdminAuthGuard } from '../common/guards/admin-auth.guard';
import { RbacGuard } from '../common/guards/rbac.guard';
import { CurrentAdmin, Permissions, type AdminPrincipal } from '../common/decorators';
import { writeArchiveResponse } from '../shared-skills/archive-response';
import { AgentPresetsService } from './agent-presets.service';

@Controller('api/server/admin/agent-presets')
@UseGuards(AdminAuthGuard, RbacGuard)
export class AgentPresetsAdminController {
  constructor(private readonly presets: AgentPresetsService) {}

  @Get()
  @Permissions('capability:read')
  async list(@Query('status') status?: string) {
    return { presets: await this.presets.listAll(status) };
  }

  @Get(':name/archive')
  @Permissions('capability:read')
  async archive(@Param('name') name: string, @Res() res: Response): Promise<void> {
    const payload = await this.presets.download(name);
    writeArchiveResponse(res, payload, 'X-Preset-Version', 'X-Preset-Checksum');
  }

  @Get(':name/preview')
  @Permissions('capability:read')
  async preview(@Param('name') name: string) {
    return this.presets.preview(name);
  }

  @Post(':name/approve')
  @HttpCode(HttpStatus.OK)
  @Permissions('capability:write')
  async approve(
    @Param('name') name: string,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.presets.approve(name, admin.username);
    return { ok: true };
  }

  @Post(':name/reject')
  @HttpCode(HttpStatus.OK)
  @Permissions('capability:write')
  async reject(
    @Param('name') name: string,
    @Body() body: { reason?: string },
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.presets.reject(name, body?.reason ?? '', admin.username);
    return { ok: true };
  }

  @Delete(':name')
  @Permissions('capability:write')
  async deleteAll(
    @Param('name') name: string,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.presets.deleteAll(name, admin.username);
    return { ok: true };
  }

  @Get(':name/:version/archive')
  @Permissions('capability:read')
  async archiveVersion(
    @Param('name') name: string,
    @Param('version') version: string,
    @Res() res: Response,
  ): Promise<void> {
    const payload = await this.presets.download(name, version);
    writeArchiveResponse(res, payload, 'X-Preset-Version', 'X-Preset-Checksum');
  }

  @Get(':name/:version/preview')
  @Permissions('capability:read')
  async previewVersion(
    @Param('name') name: string,
    @Param('version') version: string,
  ) {
    return this.presets.previewVersion(name, version);
  }

  @Post(':name/:version/approve')
  @HttpCode(HttpStatus.OK)
  @Permissions('capability:write')
  async approveVersion(
    @Param('name') name: string,
    @Param('version') version: string,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.presets.approveVersion(name, version, admin.username);
    return { ok: true };
  }

  @Post(':name/:version/reject')
  @HttpCode(HttpStatus.OK)
  @Permissions('capability:write')
  async rejectVersion(
    @Param('name') name: string,
    @Param('version') version: string,
    @Body() body: { reason?: string },
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.presets.rejectVersion(name, version, body?.reason ?? '', admin.username);
    return { ok: true };
  }

  @Delete(':name/:version')
  @Permissions('capability:write')
  async deleteVersion(
    @Param('name') name: string,
    @Param('version') version: string,
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.presets.deleteVersion(name, version, admin.username);
    return { ok: true };
  }

  @Put(':name/:version/quality')
  @Permissions('capability:write')
  async quality(
    @Param('name') name: string,
    @Param('version') version: string,
    @Body() body: { quality?: string },
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    return this.presets.setQuality(name, version, body?.quality ?? '', admin.username);
  }

  @Get(':name/:version/file')
  @Permissions('capability:read')
  async file(
    @Param('name') name: string,
    @Param('version') version: string,
    @Query('path') path?: string,
  ) {
    return this.presets.file(name, version, path ?? '');
  }

  @Get(':name/grants')
  @Permissions('capability:read')
  async grants(@Param('name') name: string) {
    return { grants: await this.presets.listGrants(name) };
  }

  @Put(':name/grants')
  @Permissions('capability:write')
  async replaceGrants(
    @Param('name') name: string,
    @Body() body: { groups?: string[] },
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.presets.replaceGrants(name, body?.groups ?? [], admin.username);
    return { ok: true };
  }

  @Put(':name/grant')
  @Permissions('capability:write')
  async grant(
    @Param('name') name: string,
    @Body() body: { username?: string; group?: string },
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.presets.grant(name, body ?? {}, admin.username);
    return { ok: true };
  }

  @Delete(':name/grant')
  @Permissions('capability:write')
  async revoke(
    @Param('name') name: string,
    @Body() body: { username?: string; group?: string },
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    await this.presets.revoke(name, body ?? {}, admin.username);
    return { ok: true };
  }

  @Put(':name/enabled')
  @Permissions('capability:write')
  async enabled(
    @Param('name') name: string,
    @Body() body: { enabled?: boolean },
    @CurrentAdmin() admin: AdminPrincipal,
  ) {
    return this.presets.setEnabled(name, body ?? {}, admin.username);
  }
}
