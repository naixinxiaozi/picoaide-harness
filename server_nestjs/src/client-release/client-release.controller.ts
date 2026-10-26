import { Controller, Get, Head, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators';
import { ApiError } from '../common/errors/api-error';
import { ClientReleaseService } from './client-release.service';

/** 员工面安装包清单（公开）：/api/client/v2/updates/manifest。 */
@Controller('api/client/v2/updates')
export class ClientReleaseController {
  constructor(private readonly svc: ClientReleaseService) {}

  @Get('manifest')
  @Public()
  manifest(@Req() req: Request): Promise<Record<string, unknown>> {
    const forwarded = req.headers['x-forwarded-proto'];
    return this.svc.manifest({
      host: (req.headers.host as string) ?? '',
      forwardedProto: Array.isArray(forwarded) ? forwarded[0] : forwarded,
      tls: req.secure,
    });
  }
}

/** 根路由安装包下载（公开，非 /api）：/updates/client/*file。 */
@Controller('updates/client')
export class ClientReleaseFileController {
  constructor(private readonly svc: ClientReleaseService) {}

  @Get('*file')
  @Head('*file')
  @Public()
  file(@Param('file') file: string, @Res() res: Response): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const name = (file ?? '').replace(/^\/+/, '');
    const full = this.svc.assetPath(name);
    if (!full) throw new ApiError('NOT_FOUND', '客户端安装包不存在');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', this.svc.assetContentType(name));
    res.setHeader('Content-Disposition', this.svc.contentDisposition(name));
    res.sendFile(full);
  }
}
