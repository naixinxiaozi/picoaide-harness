import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, type ClientPrincipal } from '../common/decorators';
import { BearerAuthGuard } from '../common/guards/bearer-auth.guard';
import { MarketplaceService } from './marketplace.service';

/**
 * 员工面技能商城 + 内置技能（/api/client/v2）。
 * 商城技能走「授权 → 下架」双门判定；内置技能无授权过滤（登录即可见）。
 */
@Controller('api/client/v2')
@UseGuards(BearerAuthGuard)
export class MarketplaceController {
  constructor(private readonly svc: MarketplaceService) {}

  @Get('marketplace/skills')
  listSkills(@CurrentUser() p: ClientPrincipal) {
    return this.svc
      .listMarketSkillsForEmployee(p.username, p.role, p.userId)
      .then((skills) => ({ skills }));
  }

  @Get('marketplace/skills/:name')
  getSkill(
    @Param('name') name: string,
    @CurrentUser() p: ClientPrincipal,
  ) {
    return this.svc
      .getMarketSkill(name, p.username, p.role, p.userId)
      .then((skill) => ({ skill }));
  }

  @Get('marketplace/skills/:name/archive')
  downloadArchive(
    @Param('name') name: string,
    @CurrentUser() p: ClientPrincipal,
  ) {
    // 授权判定先行（未授权 404），再尝试归档。
    return this.svc
      .getMarketSkill(name, p.username, p.role, p.userId)
      .then(() => this.svc.downloadSkillArchive(name));
  }

  @Get('skills/builtin')
  async listBuiltin(): Promise<{ skills: unknown[] }> {
    const skills = await this.svc.listBuiltin();
    return { skills };
  }

  @Get('skills/builtin/:name/archive')
  builtinArchive(@Param('name') name: string, @Res() res: Response) {
    // 内置技能无归档目录 → 结构响应（端点注册）。
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '内置技能归档未存储' } });
  }
}
