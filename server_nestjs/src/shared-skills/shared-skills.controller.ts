import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, type ClientPrincipal } from '../common/decorators';
import { BearerAuthGuard } from '../common/guards/bearer-auth.guard';
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
  upload(
    @Body() body: Record<string, unknown>,
    @CurrentUser() p: ClientPrincipal,
  ) {
    return this.svc.upload(body as never, p.username).then((skill) => ({ skill }));
  }

  @Get(':name/:version/archive')
  download(
    @Param('name') name: string,
    @Param('version') version: string,
    @CurrentUser() p: ClientPrincipal,
  ) {
    return this.svc.downloadForEmployee(name, version, p.username, p.role, p.userId);
  }
}
