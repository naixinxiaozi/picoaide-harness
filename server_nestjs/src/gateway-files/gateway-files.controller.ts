import { Controller, Delete, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BearerAuthGuard } from '../common/guards/bearer-auth.guard';
import { CurrentUser, type ClientPrincipal } from '../common/decorators';
import { GatewayFilesService } from './gateway-files.service';

function rawBodyOf(req: Request): Buffer {
  const b = req.body;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b, 'utf8');
  if (b && typeof b === 'object') return Buffer.from(JSON.stringify(b), 'utf8');
  return Buffer.alloc(0);
}

@Controller('v1/files')
@UseGuards(BearerAuthGuard)
export class GatewayFilesV1Controller {
  constructor(private readonly files: GatewayFilesService) {}

  @Post()
  async upload(@CurrentUser() p: ClientPrincipal, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.files.uploadFile(p.userId, rawBodyOf(req), req.headers['content-type'] ?? 'application/json', res);
  }

  @Get()
  async list(@CurrentUser() p: ClientPrincipal, @Req() req: Request, @Res() res: Response): Promise<void> {
    const idx = req.originalUrl.indexOf('?');
    await this.files.listFiles(p.userId, idx >= 0 ? req.originalUrl.slice(idx + 1) : '', res);
  }

  @Get(':file_id')
  async retrieve(@CurrentUser() p: ClientPrincipal, @Param('file_id') fileId: string, @Res() res: Response): Promise<void> {
    await this.files.retrieveFile(p.userId, fileId, res);
  }

  @Delete(':file_id')
  async remove(@CurrentUser() p: ClientPrincipal, @Param('file_id') fileId: string): Promise<unknown> {
    return this.files.deleteFile(p.userId, fileId);
  }
}

@Controller('files')
@UseGuards(BearerAuthGuard)
export class GatewayFilesRootController {
  constructor(private readonly files: GatewayFilesService) {}

  @Post()
  async upload(@CurrentUser() p: ClientPrincipal, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.files.uploadFile(p.userId, rawBodyOf(req), req.headers['content-type'] ?? 'application/json', res);
  }

  @Get()
  async list(@CurrentUser() p: ClientPrincipal, @Req() req: Request, @Res() res: Response): Promise<void> {
    const idx = req.originalUrl.indexOf('?');
    await this.files.listFiles(p.userId, idx >= 0 ? req.originalUrl.slice(idx + 1) : '', res);
  }

  @Get(':file_id')
  async retrieve(@CurrentUser() p: ClientPrincipal, @Param('file_id') fileId: string, @Res() res: Response): Promise<void> {
    await this.files.retrieveFile(p.userId, fileId, res);
  }

  @Delete(':file_id')
  async remove(@CurrentUser() p: ClientPrincipal, @Param('file_id') fileId: string): Promise<unknown> {
    return this.files.deleteFile(p.userId, fileId);
  }
}
