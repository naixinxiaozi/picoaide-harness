import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  PERMISSIONS_KEY,
  type AdminPrincipal,
} from '../decorators';
import { roleHas, type AdminRole, type Permission } from '../rbac/permissions';
import { ApiError } from '../errors/api-error';

/**
 * RBAC 权限守卫：校验 req.admin 的角色是否覆盖 @Permissions(...) 声明的权限点。
 * 无 @Permissions 元数据时放行（已通过 AdminAuth 即视为登录即可）。
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const admin = (req as Request & { admin?: AdminPrincipal }).admin;
    if (!admin) throw new ApiError('AUTH_REQUIRED', 'missing session');

    for (const perm of required) {
      if (!roleHas(admin.role as AdminRole, perm)) {
        throw new ApiError('FORBIDDEN', `missing permission: ${perm}`);
      }
    }
    return true;
  }
}
