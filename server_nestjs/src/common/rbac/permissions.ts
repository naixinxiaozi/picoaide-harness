/**
 * 权限点定义（与现有 server 的 rbac.go 逐字对齐）。
 * 命名规范：<域>:<动作>。角色映射见 ROLE_PERMISSIONS。
 */

export const PERMISSIONS = [
  'user:read',
  'user:write',
  'dept:read',
  'dept:write',
  'auth:read',
  'auth:write',
  'gateway:read',
  'gateway:write',
  'usage:read',
  'report:read',
  'report:write',
  'market:read',
  'market:write',
  'capability:read',
  'capability:write',
  'connector:read',
  'connector:write',
  'audit:read',
  'audit:retention:write',
  'portal:read',
  'portal:write',
  'server-info:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** 管理端角色（users.role）。 */
export const ADMIN_ROLES = ['super_admin', 'auditor', 'user'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** super_admin 全量权限。 */
export const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS;

/** auditor 只读三重（不含 report:read——hook_url 是凭据本体）。 */
export const AUDITOR_PERMISSIONS: readonly Permission[] = [
  'audit:read',
  'usage:read',
  'user:read',
];

export const ROLE_PERMISSIONS: Record<AdminRole, ReadonlySet<Permission>> = {
  super_admin: new Set<Permission>(ALL_PERMISSIONS),
  auditor: new Set<Permission>(AUDITOR_PERMISSIONS),
  user: new Set<Permission>(),
};

/** 当前角色是否有该权限点（super_admin 恒 true）。 */
export function roleHas(role: AdminRole, permission: Permission): boolean {
  if (role === 'super_admin') return true;
  return ROLE_PERMISSIONS[role].has(permission);
}

/** 当前角色的权限点数组（下发到 userJSON.permissions）。 */
export function permissionsOf(role: AdminRole): Permission[] {
  if (role === 'super_admin') return [...ALL_PERMISSIONS];
  return [...ROLE_PERMISSIONS[role]];
}

/** 是否有管理面访问权（super_admin / auditor；user 拒绝）。 */
export function hasManagementAccess(role: AdminRole): boolean {
  return role === 'super_admin' || role === 'auditor';
}
