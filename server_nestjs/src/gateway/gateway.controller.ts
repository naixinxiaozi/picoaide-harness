import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { BearerAuthGuard } from '../common/guards/bearer-auth.guard';
import { CurrentUser, type ClientPrincipal } from '../common/decorators';
import { UsersService } from '../users/users.service';
import { ApiError } from '../common/errors/api-error';
import { GatewayService } from './gateway.service';

function rawBodyOf(req: Request): Buffer {
  const b = req.body;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b, 'utf8');
  if (b && typeof b === 'object') return Buffer.from(JSON.stringify(b), 'utf8');
  return Buffer.alloc(0);
}

/**
 * Client LLM proxy endpoints. Every handler reads the raw request body as a
 * Buffer (wired via a raw-body middleware in main.ts) and hands the full User
 * row to GatewayService so the balance gate and metering can read balance /
 * balance_activated_at / is_admin.
 */
@Controller('v1')
@UseGuards(BearerAuthGuard)
export class GatewayV1Controller {
  constructor(
    private readonly gateway: GatewayService,
    private readonly users: UsersService,
  ) {}

  private async requireUser(p: ClientPrincipal) {
    const user = await this.users.findById(p.userId);
    if (!user) throw new ApiError('AUTH_REQUIRED', '用户不存在或已禁用');
    return user;
  }

  @Post('chat/completions')
  async chatCompletions(
    @CurrentUser() p: ClientPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.gateway.chatCompletions(await this.requireUser(p), rawBodyOf(req), res);
  }

  @Post('embeddings')
  async embeddings(
    @CurrentUser() p: ClientPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.gateway.embeddings(await this.requireUser(p), rawBodyOf(req), res);
  }

  @Post('messages')
  async messages(
    @CurrentUser() p: ClientPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.gateway.messages(await this.requireUser(p), rawBodyOf(req), res);
  }

  @Post('completions')
  async completions(
    @CurrentUser() p: ClientPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.gateway.completions(await this.requireUser(p), rawBodyOf(req), res);
  }

  @Post('responses')
  async responses(
    @CurrentUser() p: ClientPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.gateway.responses(await this.requireUser(p), rawBodyOf(req), res);
  }

  @Get('models')
  async models(): Promise<unknown> {
    return this.gateway.listModels();
  }
}

/** Bare (root-level) LLM proxy endpoints, mirroring the /v1 group. */
@Controller()
@UseGuards(BearerAuthGuard)
export class GatewayRootController {
  constructor(
    private readonly gateway: GatewayService,
    private readonly users: UsersService,
  ) {}

  private async requireUser(p: ClientPrincipal) {
    const user = await this.users.findById(p.userId);
    if (!user) throw new ApiError('AUTH_REQUIRED', '用户不存在或已禁用');
    return user;
  }

  @Post('chat/completions')
  async chatCompletions(
    @CurrentUser() p: ClientPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.gateway.chatCompletions(await this.requireUser(p), rawBodyOf(req), res);
  }

  @Post('embeddings')
  async embeddings(
    @CurrentUser() p: ClientPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.gateway.embeddings(await this.requireUser(p), rawBodyOf(req), res);
  }

  @Post('messages')
  async messages(
    @CurrentUser() p: ClientPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.gateway.messages(await this.requireUser(p), rawBodyOf(req), res);
  }

  @Post('completions')
  async completions(
    @CurrentUser() p: ClientPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.gateway.completions(await this.requireUser(p), rawBodyOf(req), res);
  }

  @Post('responses')
  async responses(
    @CurrentUser() p: ClientPrincipal,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.gateway.responses(await this.requireUser(p), rawBodyOf(req), res);
  }

  @Get('models')
  async models(): Promise<unknown> {
    return this.gateway.listModels();
  }
}
