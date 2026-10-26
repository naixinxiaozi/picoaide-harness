import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Permission } from './rbac/permissions';

/** 当前客户端用户（BearerAuth 注入）。 */
export interface ClientPrincipal {
  userId: number;
  username: string;
  role: string;
  /** users.is_admin（1=管理员）。Go 侧可见性判据多处用 IsAdmin 而非 role。 */
  isAdmin: number;
}

/** 当前管理端用户（AdminAuth 注入）。 */
export interface AdminPrincipal {
  userId: number;
  username: string;
  role: string;
  /** cookie 值（会话 secret，用于 re-issue 会话绑定 CSRF token）。 */
  sessionSecret: string;
  /** 会话 CSRF 密钥。 */
  csrfKey: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientPrincipal =>
    ctx.switchToHttp().getRequest().user as ClientPrincipal,
);

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AdminPrincipal =>
    ctx.switchToHttp().getRequest().admin as AdminPrincipal,
);

export const IS_PUBLIC_KEY = 'isPublic';
/** 标记公开路由（跳过认证）。 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'permissions';
/** 声明所需权限点（配合 AdminAuth + RbacGuard）。 */
export const Permissions = (...perms: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);
