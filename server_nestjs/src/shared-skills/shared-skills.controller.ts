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
import { CurrentUser, type ClientPrincipal } from '../common/decorators';
import { BearerAuthGuard } from '../common/guards/bearer-auth.guard';
import { writeArchiveResponse } from './archive-response';
import { SharedSkillsService } from './shared-skills.service';

/** 员工面共享技能（/api/client/v2/shared-skills）。 */
@Controller('api/client/v2/shared-skills')
@UseGuards(BearerAuthGuard)
export class SharedSkillsController {
  constructor(private readonly svc: SharedSkillsService) {}

  @Get()
  list(@CurrentUser() p: ClientPrincipal) {
    return this.svc
      .listVisibleForEmployee(p.username, p.role, p.userId)
      .then((skills) => ({ skills }));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  upload(@Body() body: Record<string, unknown>, @CurrentUser() p: ClientPrincipal) {
    return this.svc.upload(body as never, p.username).then((skill) => ({ skill }));
  }

  @Get(':name/:version/archive')
  async download(
    @Param('name') name: string,
    @Param('version') version: string,
    @CurrentUser() p: ClientPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    const archive = await this.svc.downloadForEmployee(name, version, p.username, p.role, p.userId);
    writeArchiveResponse(res, archive, 'X-Skill-Version', 'X-Skill-Checksum');
  }
}
