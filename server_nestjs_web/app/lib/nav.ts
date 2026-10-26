// 侧栏导航声明 + 可见性过滤（与现有 webadmin 的 nav.ts 对齐）。
// 以服务端 /me 下发的 permissions 为唯一依据；未声明 perms 的条目 fail-closed（仅超管可见）。

export interface SessionUser {
  id: number
  username: string
  display_name: string
  email: string
  role: 'super_admin' | 'auditor' | 'user'
  permissions: string[]
  is_admin: boolean
  status: number
}

export interface NavEntry {
  to: string
  label: string
  icon: string
  section: '管理' | '运维' | '审计'
  /** 可见所需权限点（任一命中即可）；缺省 = 仅超管可见（fail-closed）。 */
  perms?: string[]
}

// 权限点常量（与服务端 rbac 权限点逐字对齐）。
export const PERM_USER_READ = 'user:read'
export const PERM_DEPT_READ = 'dept:read'
export const PERM_AUTH_READ = 'auth:read'
export const PERM_GATEWAY_READ = 'gateway:read'
export const PERM_USAGE_READ = 'usage:read'
export const PERM_MARKET_READ = 'market:read'
export const PERM_CAP_READ = 'capability:read'
export const PERM_CONNECTOR_READ = 'connector:read'
export const PERM_SERVERINFO_READ = 'server-info:read'
export const PERM_AUDIT_READ = 'audit:read'

const CORE_NAV_ENTRIES_HEAD: NavEntry[] = [
  { to: '/users', label: '用户', icon: 'i-lucide-users', section: '管理', perms: [PERM_USER_READ] },
  { to: '/departments', label: '部门', icon: 'i-lucide-network', section: '管理', perms: [PERM_DEPT_READ] },
  { to: '/auth', label: '认证', icon: 'i-lucide-key-round', section: '管理', perms: [PERM_AUTH_READ] },
  { to: '/gateway', label: '网关', icon: 'i-lucide-settings-2', section: '运维', perms: [PERM_GATEWAY_READ] },
  { to: '/gateway-files', label: '网关文件', icon: 'i-lucide-hard-drive', section: '运维', perms: [PERM_GATEWAY_READ] },
  { to: '/error-monitoring', label: '错误监控', icon: 'i-lucide-bug', section: '运维', perms: [PERM_SERVERINFO_READ] },
  { to: '/usage', label: '用量中心', icon: 'i-lucide-chart-bar', section: '运维', perms: [PERM_USAGE_READ] },
]

// 模块条目（WASM 应用平台 /app-center 已按需求排除）。
const FEATURE_NAV_ENTRIES: NavEntry[] = [
  { to: '/capabilities', label: '能力中心', icon: 'i-lucide-store', section: '运维', perms: [PERM_MARKET_READ, PERM_CAP_READ] },
  { to: '/connectors', label: '连接器', icon: 'i-lucide-plug', section: '运维', perms: [PERM_CONNECTOR_READ] },
]

const CORE_NAV_ENTRIES_TAIL: NavEntry[] = [
  { to: '/server-info', label: '服务器信息', icon: 'i-lucide-server', section: '运维', perms: [PERM_SERVERINFO_READ] },
  { to: '/audit', label: '审计日志', icon: 'i-lucide-scroll-text', section: '审计', perms: [PERM_AUDIT_READ] },
]

export const NAV_ENTRIES: NavEntry[] = [
  ...CORE_NAV_ENTRIES_HEAD,
  ...FEATURE_NAV_ENTRIES,
  ...CORE_NAV_ENTRIES_TAIL,
]

/** 单个条目是否对当前用户可见。 */
export function isNavVisible(entry: NavEntry, user: SessionUser | null | undefined): boolean {
  const granted = user?.permissions
  if (Array.isArray(granted)) {
    if (!entry.perms || entry.perms.length === 0) return user?.role === 'super_admin'
    return entry.perms.some((p) => granted.includes(p))
  }
  if (user?.role === 'super_admin') return true
  if (user?.role === 'auditor') return entry.section === '审计'
  return false
}

/** 按服务端权限过滤后的导航。 */
export function visibleNav(user: SessionUser | null | undefined): NavEntry[] {
  return NAV_ENTRIES.filter((n) => isNavVisible(n, user))
}

/** 登录落地页：审计员优先审计日志，否则第一个可见条目。 */
export function landingPath(user: SessionUser | null | undefined): string {
  const visible = visibleNav(user)
  if (user?.role === 'auditor' && visible.some((n) => n.to === '/audit')) return '/audit'
  return visible[0]?.to ?? '/users'
}
