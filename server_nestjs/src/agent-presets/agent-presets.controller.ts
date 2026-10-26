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
import { BearerAuthGuard } from '../common/guards/bearer-auth.guard';
import { CurrentUser, type ClientPrincipal } from '../common/decorators';
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
  async upload(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: ClientPrincipal,
  ) {
    const result = await this.presets.upload(body, user.username);
    return { preset: result };
  }

  @Get(':name/archive')
  async archive(
    @Param('name') name: string,
    @CurrentUser() user: ClientPrincipal,
  ) {
    await this.presets.downloadForEmployee(
      name,
      undefined,
      user.username,
      user.role,
      user.userId,
    );
    // 到达此处即命中 404（无归档字节列）；返回值仅为满足类型。
    return undefined;
  }

  @Get(':name/:version/archive')
  async archiveVersion(
    @Param('name') name: string,
    @Param('version') version: string,
    @CurrentUser() user: ClientPrincipal,
  ) {
    await this.presets.downloadForEmployee(
      name,
      version,
      user.username,
      user.role,
      user.userId,
    );
    return undefined;
  }
}
