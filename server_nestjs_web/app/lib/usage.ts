// 用量中心共享类型与格式化工具（与 contract-01 §5/§6、contract-04 §6 对齐）。

export interface UsageAggregateRow {
  label: string
  prompt_tokens: number
  completion_tokens: number
  requests: number
  embed_requests: number
  embed_tokens: number
  cache_tokens: number
  cost: number
}

export interface UsageRequestRow {
  id: number
  time: string
  user_id: number
  username: string
  model: string
  kind: string
  prompt_tokens: number
  completion_tokens: number
  cache_tokens: number
  search_requests: number
  cost: number
  estimated: boolean
}

export interface UsageMetric {
  cost: number
  tokens: number
  requests: number
}

export interface UsageOverview {
  range: UsageMetric
  month: UsageMetric
  today: UsageMetric
  trend: UsageAggregateRow[]
  top_models: UsageAggregateRow[]
}

export interface UsageAggregateResponse {
  rows: UsageAggregateRow[]
  group: string
  truncated: boolean
}

export interface UsageRequestsResponse {
  rows: UsageRequestRow[]
  total: number
  page: number
  size: number
  kind: string
}

export interface BalanceSettings {
  enabled: boolean
  monthly_amount: number
  monthly_mode: string
}

export interface GrantRun {
  month: string
  mode: string
  amount: number
  granted: number
  skipped: number
  actor: string
  cover_debt_users: number
  cover_debt_amount: number
}

export interface BalanceGrant {
  month: string
  mode: string
  amount: number
  affected: number
  actor: string
  created_at: string
}

export interface GrantStatus {
  month: string
  eligible: number
  granted: number
  pending: number
  activated: number
  last_grant: BalanceGrant | null
}

export interface BalanceSummary {
  settings: BalanceSettings
  last_grant: BalanceGrant | null
  month_grant: BalanceGrant | null
  status: GrantStatus
  users: number
  total_balance: number
  overdrawn_users: number
  overdrawn_debt: number
}

export interface ReportSubscription {
  id: number
  name: string
  enabled: boolean
  hook_url: string
  last_run_at: string
  last_error: string
  pending_period: string
  fail_streak: number
  next_attempt_at: string
  created_at: string
  updated_at: string
}

/** 金额：两位小数，元。 */
// 金额紧凑格式:>=1e6 → 123.5万,>=1e4 → 1.2万,>=1000 → 1,234,其余两位小数
export function fmtMoney(n: number): string {
  if (!isFinite(n)) return '—'
  if (n >= 1_000_000) return `${Number((n / 10000).toFixed(1))}万`
  if (n >= 10000) return `${Number((n / 10000).toFixed(1))}万`
  if (n >= 1000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** 整数：千分位。 */
export function fmtInt(value: number): string {
  return Math.round(Number(value ?? 0)).toLocaleString('zh-CN')
}

/** token 合计（prompt + completion）。 */
export function fmtTokens(row: Pick<UsageAggregateRow, 'prompt_tokens' | 'completion_tokens'>): string {
  return fmtInt(Number(row.prompt_tokens ?? 0) + Number(row.completion_tokens ?? 0))
}

export function fmtTokens1(n: number): string {
  if (n >= 1000000) return `${Number((n / 1000000).toFixed(1))}M`
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}K`
  return String(n)
}

/** RFC3339 → 本地可读时间。 */
export function fmtTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString('zh-CN', { hour12: false })
}

/** 用量类型中文名。 */
const USAGE_KIND_LABELS: Record<string, string> = {
  chat: '对话',
  completions: '补全',
  responses: '响应',
  embedding: '嵌入',
  search: '搜索',
}

export function kindLabel(kind: string): string {
  return USAGE_KIND_LABELS[kind] ?? kind
}

/** 发放模式中文名。 */
export function balanceModeLabel(mode: string): string {
  return mode === 'cover' ? '清零后重发' : '累加'
}
