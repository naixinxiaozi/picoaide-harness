import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { BearerAuthGuard } from '../common/guards/bearer-auth.guard';
import { CurrentUser, type ClientPrincipal } from '../common/decorators';
import { writeArchiveResponse } from '../shared-skills/archive-response';
import { AgentPresetsService } from './agent-presets.service';

@Controller('api/client/v2/agent-presets')
@UseGuards(BearerAuthGuard)
export class AgentPresetsController {
  constructor(private readonly presets: AgentPresetsService) {}

  @Get()
  async list(@CurrentUser() user: ClientPrincipal) {
    const items = await this.presets.listVisibleForEmployee(
      user.username,
      user.role,
      user.userId,
    );
    return { presets: items };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async upload(@Body() body: Record<string, unknown>, @CurrentUser() user: ClientPrincipal) {
    const result = await this.presets.upload(body, user.username);
    return { preset: result };
  }

  /** 无版本号的下载：取最高已通过版本，否则取最新版本（与 Go latestPresetRelease 一致）。 */
  @Get(':name/archive')
  async archive(
    @Param('name') name: string,
    @CurrentUser() user: ClientPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    const payload = await this.presets.downloadForEmployee(
      name,
      undefined,
      user.username,
      user.role,
      user.userId,
    );
    writeArchiveResponse(res, payload, 'X-Preset-Version', 'X-Preset-Checksum');
  }

  @Get(':name/:version/archive')
  async archiveVersion(
    @Param('name') name: string,
    @Param('version') version: string,
    @CurrentUser() user: ClientPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    const payload = await this.presets.downloadForEmployee(
      name,
      version,
      user.username,
      user.role,
      user.userId,
    );
    writeArchiveResponse(res, payload, 'X-Preset-Version', 'X-Preset-Checksum');
  }
}
