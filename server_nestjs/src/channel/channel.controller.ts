import { Controller, Get, Head, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/decorators';
import { ApiError } from '../common/errors/api-error';
import { ASSET_CSP, ASSET_NO_SNIFF, ChannelService } from './channel.service';

/**
 * 员工面渠道（公开）：/api/client/v2/channel 及 logo/logo-dark/favicon 素材。
 */
@Controller('api/client/v2/channel')
export class ChannelController {
  constructor(private readonly channel: ChannelService) {}

  @Get()
  @Public()
  channelInfo(): Record<string, unknown> {
    return this.channel.buildResponse();
  }

  @Get('logo')
  @Head('logo')
  @Public()
  async logo(@Res() res: Response): Promise<void> {
    await this.serveAsset(res, this.channel.logoPath(), '渠道未配置 logo');
  }

  @Get('logo-dark')
  @Head('logo-dark')
  @Public()
  async logoDark(@Res() res: Response): Promise<void> {
    await this.serveAsset(res, this.channel.logoDarkPath(), '渠道未配置暗色 logo');
  }

  @Get('favicon')
  @Head('favicon')
  @Public()
  async favicon(@Res() res: Response): Promise<void> {
    await this.serveAsset(res, this.channel.faviconPath(), '渠道未配置 favicon');
  }

  private async serveAsset(res: Response, file: string, missingMessage: string): Promise<void> {
    // 与 Go serveAsset 一致：先设 nosniff+CSP，再判 404（404 也带这两个头）。
    res.setHeader('X-Content-Type-Options', ASSET_NO_SNIFF);
    res.setHeader('Content-Security-Policy', ASSET_CSP);
    if (!file) throw new ApiError('NOT_FOUND', missingMessage);
    const reason = await this.channel.checkAsset(file);
    if (reason) throw new ApiError('NOT_FOUND', missingMessage);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file);
  }
}
