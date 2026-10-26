import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../db/database.module';
import { CryptoService } from '../crypto/crypto.service';
import { ApiError } from '../errors/api-error';
import { apiTokens, users } from '../../db/schema';
import { IS_PUBLIC_KEY, type ClientPrincipal } from '../decorators';

/**
 * 客户端 Bearer token 认证守卫（/api/client/v2 面）。
 * token 只存 SHA-256 哈希，校验通过后把 principal 注入 req.user。
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly crypto: CryptoService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])) {
      return true;
    }

    const req = ctx.switchToHttp().getRequest<Request>();
    const token = extractBearer(req.headers.authorization);
    if (!token) throw new ApiError('AUTH_REQUIRED', 'missing bearer token');

    const hash = this.crypto.sha256(token);
    const [row] = await this.db
      .select({ user: users, token: apiTokens })
      .from(apiTokens)
      .innerJoin(users, eq(apiTokens.userId, users.id))
      .where(and(eq(apiTokens.tokenHash, hash), eq(apiTokens.revoked, 0)))
      .limit(1);

    if (!row) throw new ApiError('AUTH_FAILED', 'invalid token');
    if (row.token.expiresAt && row.token.expiresAt.getTime() < Date.now()) {
      throw new ApiError('AUTH_FAILED', 'token expired');
    }
    if (row.user.status !== 1) {
      throw new ApiError('AUTH_FAILED', 'account disabled');
    }

    const principal: ClientPrincipal = {
      userId: row.user.id,
      username: row.user.username,
      role: row.user.role,
      isAdmin: row.user.isAdmin,
    };
    (req as Request & { user: ClientPrincipal }).user = principal;
    return true;
  }
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}
