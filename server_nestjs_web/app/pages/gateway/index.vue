<script setup lang="ts">
import { type SessionUser } from '~/lib/nav'

interface Provider {
  id: number
  name: string
  base_url: string
  api_key: string
  models: string[]
  enabled: boolean
  channel: string
  protocol: string
}

interface Channel {
  name: string
  base_url: string
}

interface Model {
  id: number
  name: string
  provider_id?: number
  display_name: string
  default_params: string
  input_modalities?: string[]
  input_price_per_1m?: number | null
  output_price_per_1m?: number | null
  cache_input_price_per_1m?: number | null
  offpeak_discount?: number | null
  provider_name?: string
  provider_channel?: string
  provider_enabled?: boolean
  catalog_missing?: boolean
}

interface PeakWindowRow {
  keyId: string
  start: string
  end: string
  weekdays: number[]
}

interface SyncResult {
  provider: string
  added: number
  removed: number
  skipped?: boolean
  error?: string
}

interface BalanceInfo {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}

interface BalanceResult {
  supported?: boolean
  is_available?: boolean
  infos?: BalanceInfo[]
  error?: string
  fetched_at?: string
}

interface GatewayCfg {
  default_model: string
  rate_limit: string
  peak_windows: string
  search_price_per_1k: string
  retention_months: string
  default_thinking_level: string
  server_base_url: string
  max_file_refs: string
  body_parse_budget_mb: string
  file_expiry_days: string
  unpriced_model_policy: string
}

const MANUAL_CHANNEL = '__manual__'
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]

function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

type PeakParse = { ok: true; rows: PeakWindowRow[] } | { ok: false }

function parsePeakWindows(s: string): PeakParse {
  if (s.trim() === '') return { ok: true, rows: [] }
  let arr: unknown
  try {
    arr = JSON.parse(s)
  }
  catch {
    return { ok: false }
  }
  if (!Array.isArray(arr)) return { ok: false }
  const rows = (arr as Array<Record<string, unknown>>)
    .filter((w) => w && typeof w.start === 'string' && typeof w.end === 'string')
    .map((w) => ({
      keyId: `pk-${uid()}`,
      start: w.start as string,
      end: w.end as string,
      weekdays: w.weekdays === undefined || w.weekdays === null
        ? ALL_WEEKDAYS
        : (Array.isArray(w.weekdays)
          ? (w.weekdays as unknown[]).filter((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7) as number[]
          : ALL_WEEKDAYS),
    }))
  if (arr.length > 0 && rows.length === 0) return { ok: false }
  return { ok: true, rows }
}

function formatCaps(defaultParams: string): string {
  try {
    const p = JSON.parse(defaultParams) as Record<string, unknown>
    const fmt = (n?: number) => {
      if (!n) return ''
      if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}M`
      if (n % 1024 === 0) return `${n / 1024}K`
      return `${Math.round(n / 1024)}K`
    }
    const cl = fmt(typeof p.context_length === 'number' ? p.context_length : undefined)
    const mo = fmt(typeof p.max_output === 'number' ? p.max_output : undefined)
    if (cl && mo) return `${cl} / ${mo}`
    return cl || mo || '-'
  }
  catch {
    return '-'
  }
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  }
  catch {
    return false
  }
}

function sameModelList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

function validatePriceField(label: string, raw: string, isDiscount = false): string | null {
  if (raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return `${label}必须是有效数字`
  if (n < 0) return `${label}不能为负数`
  if (isDiscount && (n <= 0 || n >= 1)) return `${label}必须在 (0,1) 之间`
  return null
}

function parseDefaultParams(raw: string): { contextLength: string; maxOutput: string; concurrencyTarget: string } {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      contextLength: typeof p.context_length === 'number' && p.context_length > 0 ? String(p.context_length) : '',
      maxOutput: typeof p.max_output === 'number' && p.max_output > 0 ? String(p.max_output) : '',
      concurrencyTarget: typeof p.concurrency_target === 'number' && p.concurrency_target > 0 ? String(p.concurrency_target) : '',
    }
  }
  catch {
    return { contextLength: '', maxOutput: '', concurrencyTarget: '' }
  }
}

const { request } = useApi()
const { data: authData } = useAuth()
const user = computed<SessionUser | null>(() => (authData.value as SessionUser | null) ?? null)
const canWrite = computed(() => user.value?.permissions?.includes('gateway:write') ?? false)

const providers = ref<Provider[]>([])
const models = ref<Model[]>([])
const channels = ref<Channel[]>([])

const cfg = ref<GatewayCfg>({
  default_model: '',
  rate_limit: '0',
  peak_windows: '',
  search_price_per_1k: '0',
  retention_months: '6',
  default_thinking_level: 'max',
  server_base_url: '',
  max_file_refs: '600',
  body_parse_budget_mb: '128',
  file_expiry_days: '7',
  unpriced_model_policy: 'reject',
})

const peakList = ref<PeakWindowRow[]>([])
const peakParseFailed = ref(false)
const peakClearConfirmed = ref(false)
const peakClearDialog = ref(false)

const loading = ref(true)
const cfgLoaded = ref(false)
const error = ref('')
const okMsg = ref('')
const syncMsg = ref('')
const warnings = ref<string[]>([])
const busy = ref<string | null>(null)

// 上游 Provider 表单
const provDialog = ref(false)
const provErr = ref('')
const provForm = ref({ name: '', channel: '', base_url: '', api_key: '', models: '', protocol: '' })

const editProv = ref<Provider | null>(null)
const editProvErr = ref('')
const editProvForm = ref({ name: '', channel: '', base_url: '', api_key: '', models: '', enabled: true, protocol: '' })

// 模型表单
const modelDialog = ref(false)
const modelErr = ref('')
const modelForm = ref({
  name: '',
  provider_id: '',
  display_name: '',
  input_modalities: 'text',
  input_price_per_1m: '',
  output_price_per_1m: '',
  cache_input_price_per_1m: '',
  offpeak_discount: '',
})

const editModel = ref<Model | null>(null)
const priceErr = ref('')
const editModelForm = ref({
  input: '',
  output: '',
  cache: '',
  offpeak: '',
  modalities: 'text',
  displayName: '',
  providerId: '',
  contextLength: '',
  maxOutput: '',
  concurrencyTarget: '',
  originalDefaultParams: '{}',
})

// 余额查询
const balanceDialog = ref(false)
const balanceLoading = ref(false)
const balanceErr = ref('')
const balanceProvName = ref('')
const balance = ref<BalanceResult | null>(null)

async function load() {
  loading.value = true
  try {
    const [p, m, g, ch] = await Promise.all([
      request<{ providers?: Provider[] }>('/api/server/admin/providers'),
      request<{ models?: Model[] }>('/api/server/admin/models'),
      request<Record<string, unknown>>('/api/server/admin/gateway'),
      request<{ channels?: Channel[] }>('/api/server/admin/channels'),
    ])
    providers.value = p.providers ?? []
    models.value = m.models ?? []
    cfg.value = {
      default_model: (g.default_model as string) ?? '',
      rate_limit: String(g.rate_limit ?? '0'),
      peak_windows: (g.peak_windows as string) ?? '',
      search_price_per_1k: String(g.search_price_per_1k ?? '0'),
      retention_months: (g.retention_months as string) ?? '6',
      default_thinking_level: (g.default_thinking_level as string) ?? 'max',
      server_base_url: (g.server_base_url as string) ?? '',
      max_file_refs: String(g.max_file_refs ?? '600'),
      body_parse_budget_mb: String(g.body_parse_budget_mb ?? '128'),
      file_expiry_days: String(g.file_expiry_days ?? '7'),
      unpriced_model_policy: String(g.unpriced_model_policy ?? 'reject'),
    }
    const peak = parsePeakWindows(cfg.value.peak_windows)
    if (peak.ok) {
      peakList.value = peak.rows
      peakParseFailed.value = false
    }
    else {
      peakList.value = []
      peakParseFailed.value = true
    }
    channels.value = ch.channels ?? []
    error.value = ''
    cfgLoaded.value = true
  }
  catch (e) {
    error.value = (e as Error).message
    cfgLoaded.value = false
  }
  finally {
    loading.value = false
  }
}

function flash(msg: string) {
  okMsg.value = msg
}

async function saveGateway() {
  if (busy.value) return
  const rl = Number(cfg.value.rate_limit)
  if (!Number.isInteger(rl) || rl < 0 || rl > 100000) {
    error.value = '每用户限流必须是 0~100000 的整数(0=不限制)'
    return
  }
  if (cfg.value.retention_months !== '') {
    const rm = Number(cfg.value.retention_months)
    if (!Number.isInteger(rm) || rm < 0 || rm > 120) {
      error.value = '明细保留必须 0-120 个月(0=永不删除)'
      return
    }
  }
  if (cfg.value.server_base_url && !isHttpUrl(cfg.value.server_base_url)) {
    error.value = '对外访问地址必须是 http(s) URL'
    return
  }
  const mfr = Number(cfg.value.max_file_refs)
  if (!Number.isInteger(mfr) || mfr < 1 || mfr > 4096) {
    error.value = '单请求文件引用上限必须是 1~4096 的整数'
    return
  }
  const bpb = Number(cfg.value.body_parse_budget_mb)
  if (!Number.isInteger(bpb) || bpb < 64 || bpb > 8192) {
    error.value = '请求体加工内存预算必须是 64~8192 MiB 的整数'
    return
  }
  const fed = Number(cfg.value.file_expiry_days)
  if (!Number.isInteger(fed) || fed < 1 || fed > 30) {
    error.value = '文件保留上限必须是 1~30 天的整数'
    return
  }
  if (peakParseFailed.value && peakList.value.length === 0 && !peakClearConfirmed.value) {
    error.value = '高峰时段配置无法解析(服务端存量不是本页认得的 JSON 数组):为避免静默清空计费口径,已拒绝保存。请用「添加时段」或预设按钮显式重建峰谷窗口后再保存;若确认要放弃这份存量,请用「清空高峰时段配置」并二次确认。'
    return
  }
  if (peakList.value.some((w) => !w.start || !w.end || w.start >= w.end)) {
    error.value = '高峰时段每行的开始时间必须早于结束时间'
    return
  }
  if (peakList.value.some((w) => w.weekdays.length === 0)) {
    error.value = '高峰时段每行至少要勾选一个生效星期(一天都不选请删除该行;要清空全部峰谷配置请用「清空高峰时段配置」)'
    return
  }
  if (cfg.value.search_price_per_1k.trim() !== '') {
    const sp = Number(cfg.value.search_price_per_1k)
    if (!Number.isFinite(sp) || sp < 0 || sp > 1000) {
      error.value = 'Search 按次计费必须是 0~1000 的数值(元/千次成功搜索,0=不计费)'
      return
    }
  }
  busy.value = 'save-gateway'
  try {
    const peaked = peakList.value.map(({ keyId: _drop, ...fields }) => fields)
    const body: Record<string, string> = {
      default_model: cfg.value.default_model,
      rate_limit: cfg.value.rate_limit,
      retention_months: cfg.value.retention_months,
      default_thinking_level: cfg.value.default_thinking_level,
      server_base_url: cfg.value.server_base_url,
      max_file_refs: cfg.value.max_file_refs,
      body_parse_budget_mb: cfg.value.body_parse_budget_mb,
      file_expiry_days: cfg.value.file_expiry_days,
      unpriced_model_policy: cfg.value.unpriced_model_policy,
      search_price_per_1k: cfg.value.search_price_per_1k,
      peak_windows: peaked.length ? JSON.stringify(peaked) : '',
    }
    const res = await request<{ warnings?: unknown }>('/api/server/admin/gateway', {
      method: 'PUT',
      body,
    })
    error.value = ''
    warnings.value = Array.isArray(res?.warnings) ? res.warnings.filter((w): w is string => typeof w === 'string') : []
    peakParseFailed.value = false
    peakClearConfirmed.value = false
    flash('已保存')
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = null
  }
}

const channelItems = computed(() => [
  { label: '手动型(无渠道)', value: MANUAL_CHANNEL },
  ...channels.value.map((c) => ({ label: c.name, value: c.name })),
])

function channelBaseUrl(name: string): string {
  return channels.value.find((c) => c.name === name)?.base_url ?? ''
}

function onProvChannelChange(val: string) {
  const ch = val === MANUAL_CHANNEL ? undefined : channels.value.find((c) => c.name === val)
  provForm.value.channel = ch ? ch.name : ''
  if (!provForm.value.base_url && ch) provForm.value.base_url = ch.base_url
}

function onEditProvChannelChange(val: string) {
  const ch = val === MANUAL_CHANNEL ? undefined : channels.value.find((c) => c.name === val)
  editProvForm.value.channel = ch ? ch.name : ''
  if (ch && editProvForm.value.base_url === '') editProvForm.value.base_url = ch.base_url
}

const editModelsChanged = computed(() => {
  if (editProvForm.value.channel || !editProv.value) return false
  const next = editProvForm.value.models.split(',').map((s) => s.trim()).filter(Boolean)
  return !sameModelList(next, editProv.value.models ?? [])
})

async function createProvider() {
  if (busy.value) return
  provErr.value = ''
  if (!provForm.value.name.trim()) {
    provErr.value = '请填写上游名称'
    return
  }
  if (!isHttpUrl(provForm.value.base_url)) {
    provErr.value = 'Base URL 必须是 http(s) URL'
    return
  }
  if (provForm.value.channel && !provForm.value.api_key) {
    provErr.value = '渠道型上游必须填写 API Key'
    return
  }
  busy.value = 'create-provider'
  try {
    const r = await request<{ sync?: SyncResult | null }>('/api/server/admin/providers', {
      method: 'POST',
      body: {
        name: provForm.value.name.trim(),
        channel: provForm.value.channel,
        base_url: provForm.value.base_url,
        api_key: provForm.value.api_key,
        models: provForm.value.models.split(',').map((s) => s.trim()).filter(Boolean),
        protocol: provForm.value.protocol || 'openai',
      },
    })
    const sync = r.sync
    error.value = ''
    if (sync?.error) {
      syncMsg.value = `已保存,但模型同步失败:${sync.error}(可稍后点"立即同步"重试)`
    }
    else if (sync && sync.added > 0) {
      flash(`已上架 ${sync.added} 个模型(移除 ${sync.removed ?? 0})`)
    }
    else if (sync) {
      flash('已保存,上游未返回新模型')
    }
    else {
      flash('已保存')
    }
    provDialog.value = false
    provForm.value = { name: '', channel: '', base_url: '', api_key: '', models: '', protocol: '' }
    await load()
  }
  catch (e) {
    provErr.value = (e as Error).message
  }
  finally {
    busy.value = null
  }
}

function openProviderEdit(p: Provider) {
  editProv.value = p
  editProvErr.value = ''
  editProvForm.value = {
    name: p.name,
    channel: p.channel,
    base_url: p.base_url,
    api_key: '',
    models: p.models.join(', '),
    enabled: p.enabled,
    protocol: p.protocol || 'openai',
  }
}

async function saveProviderEdit() {
  if (busy.value || !editProv.value) return
  editProvErr.value = ''
  if (!editProvForm.value.name.trim()) {
    editProvErr.value = '请填写上游名称'
    return
  }
  if (!isHttpUrl(editProvForm.value.base_url)) {
    editProvErr.value = 'Base URL 必须是 http(s) URL'
    return
  }
  if (editProvForm.value.channel && editProvForm.value.api_key.trim() === '' && (!editProv.value.api_key || editProv.value.api_key === '')) {
    editProvErr.value = '渠道型上游必须填写 API Key'
    return
  }
  busy.value = 'save-provider-edit'
  try {
    const body: Record<string, unknown> = {
      name: editProvForm.value.name.trim(),
      channel: editProvForm.value.channel,
      base_url: editProvForm.value.base_url,
      enabled: editProvForm.value.enabled,
      protocol: editProvForm.value.protocol || 'openai',
    }
    if (editProvForm.value.api_key.trim() !== '') body.api_key = editProvForm.value.api_key
    if (!editProvForm.value.channel && editProvForm.value.models.trim() !== '') {
      const next = editProvForm.value.models.split(',').map((s) => s.trim()).filter(Boolean)
      if (!sameModelList(next, editProv.value.models ?? [])) body.models = next
    }
    await request(`/api/server/admin/providers/${editProv.value.id}`, { method: 'PUT', body })
    editProv.value = null
    error.value = ''
    flash('已保存')
    await load()
  }
  catch (e) {
    editProvErr.value = (e as Error).message
  }
  finally {
    busy.value = null
  }
}

async function deleteProvider(id: number) {
  if (busy.value) return
  if (!window.confirm('删除该上游?其模型将一并删除')) return
  busy.value = `del-provider-${id}`
  try {
    await request(`/api/server/admin/providers/${id}`, { method: 'DELETE' })
    error.value = ''
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = null
  }
}

async function toggleProviderEnabled(p: Provider, enabled: boolean) {
  if (busy.value) return
  busy.value = `toggle-${p.id}`
  try {
    await request(`/api/server/admin/providers/${p.id}`, { method: 'PUT', body: { enabled } })
    error.value = ''
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = null
  }
}

async function syncOne(p: Provider) {
  if (busy.value) return
  busy.value = `sync-${p.id}`
  try {
    const r = await request<{ result?: SyncResult }>(`/api/server/admin/providers/${p.id}/sync`, { method: 'POST' })
    const res = r?.result
    if (res?.error) syncMsg.value = `${p.name}: ${res.error}`
    else if (res?.skipped) syncMsg.value = `${p.name}: 手动型上游跳过`
    else syncMsg.value = `${p.name}: +${res?.added ?? 0}/-${res?.removed ?? 0}`
    error.value = ''
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = null
  }
}

async function queryBalance(p: Provider) {
  balanceProvName.value = p.name
  balanceDialog.value = true
  balanceLoading.value = true
  balanceErr.value = ''
  balance.value = null
  try {
    balance.value = await request<BalanceResult>(`/api/server/admin/providers/${p.id}/balance`)
  }
  catch (e) {
    balanceErr.value = (e as Error).message
  }
  finally {
    balanceLoading.value = false
  }
}

const providerItems = computed(() => providers.value.map((p) => ({ label: p.name, value: String(p.id) })))

function onModelProviderChange(v: string) {
  const p = providers.value.find((x) => String(x.id) === v)
  modelForm.value.provider_id = v
  if (modelForm.value.offpeak_discount === '' && p?.channel === 'deepseek') {
    modelForm.value.offpeak_discount = '0.5'
  }
}

async function createModel() {
  if (busy.value) return
  modelErr.value = ''
  if (!modelForm.value.provider_id) {
    modelErr.value = '请选择所属上游'
    return
  }
  const validationMsg = validatePriceField('输入价格', modelForm.value.input_price_per_1m)
    ?? validatePriceField('输出价格', modelForm.value.output_price_per_1m)
    ?? validatePriceField('缓存命中输入价', modelForm.value.cache_input_price_per_1m)
    ?? validatePriceField('低谷折扣率', modelForm.value.offpeak_discount, true)
  if (validationMsg) {
    modelErr.value = validationMsg
    return
  }
  busy.value = 'create-model'
  try {
    const body: Record<string, unknown> = {
      name: modelForm.value.name,
      provider_id: Number(modelForm.value.provider_id),
      display_name: modelForm.value.display_name,
      input_modalities: modelForm.value.input_modalities === 'image' ? ['text', 'image'] : ['text'],
    }
    if (modelForm.value.input_price_per_1m.trim() !== '') body.input_price_per_1m = Number(modelForm.value.input_price_per_1m)
    if (modelForm.value.output_price_per_1m.trim() !== '') body.output_price_per_1m = Number(modelForm.value.output_price_per_1m)
    if (modelForm.value.cache_input_price_per_1m.trim() !== '') body.cache_input_price_per_1m = Number(modelForm.value.cache_input_price_per_1m)
    if (modelForm.value.offpeak_discount.trim() !== '') body.offpeak_discount = Number(modelForm.value.offpeak_discount)
    await request('/api/server/admin/models', { method: 'POST', body })
    modelDialog.value = false
    modelForm.value = {
      name: '',
      provider_id: '',
      display_name: '',
      input_modalities: 'text',
      input_price_per_1m: '',
      output_price_per_1m: '',
      cache_input_price_per_1m: '',
      offpeak_discount: '',
    }
    error.value = ''
    await load()
  }
  catch (e) {
    modelErr.value = (e as Error).message
  }
  finally {
    busy.value = null
  }
}

function openModelPricing(m: Model) {
  editModel.value = m
  priceErr.value = ''
  const dp = parseDefaultParams(m.default_params)
  editModelForm.value = {
    input: m.input_price_per_1m === null || m.input_price_per_1m === undefined ? '' : String(m.input_price_per_1m),
    output: m.output_price_per_1m === null || m.output_price_per_1m === undefined ? '' : String(m.output_price_per_1m),
    cache: m.cache_input_price_per_1m === null || m.cache_input_price_per_1m === undefined ? '' : String(m.cache_input_price_per_1m),
    offpeak: m.offpeak_discount === null || m.offpeak_discount === undefined ? '' : String(m.offpeak_discount),
    modalities: m.input_modalities?.includes('image') ? 'image' : 'text',
    displayName: m.display_name,
    providerId: m.provider_id !== undefined && m.provider_id > 0 ? String(m.provider_id) : '',
    ...dp,
    originalDefaultParams: m.default_params || '{}',
  }
}

async function saveModelPricing() {
  if (busy.value || !editModel.value) return
  priceErr.value = ''
  const validationMsg = validatePriceField('输入价格', editModelForm.value.input)
    ?? validatePriceField('输出价格', editModelForm.value.output)
    ?? validatePriceField('缓存命中输入价', editModelForm.value.cache)
    ?? validatePriceField('低谷折扣率', editModelForm.value.offpeak, true)
  if (validationMsg) {
    priceErr.value = validationMsg
    return
  }
  for (const [label, value] of [
    ['上下文窗口', editModelForm.value.contextLength],
    ['最大输出', editModelForm.value.maxOutput],
    ['并发目标', editModelForm.value.concurrencyTarget],
  ] as const) {
    if (value.trim() !== '' && (!Number.isInteger(Number(value)) || Number(value) <= 0)) {
      priceErr.value = `${label} 必须是正整数`
      return
    }
  }
  busy.value = 'save-model-pricing'
  try {
    const body: Record<string, unknown> = { name: editModel.value.name }
    if (editModelForm.value.input.trim() !== '') body.input_price_per_1m = Number(editModelForm.value.input)
    if (editModelForm.value.output.trim() !== '') body.output_price_per_1m = Number(editModelForm.value.output)
    if (editModelForm.value.cache.trim() !== '') body.cache_input_price_per_1m = Number(editModelForm.value.cache)
    if (editModelForm.value.offpeak.trim() !== '') body.offpeak_discount = Number(editModelForm.value.offpeak)
    body.input_modalities = editModelForm.value.modalities === 'image' ? ['text', 'image'] : ['text']
    if (editModelForm.value.displayName.trim() !== '') body.display_name = editModelForm.value.displayName.trim()
    if (editModelForm.value.providerId !== '') body.provider_id = Number(editModelForm.value.providerId)
    const dp = parseDefaultParams(editModelForm.value.originalDefaultParams)
    const changed = dp.contextLength !== editModelForm.value.contextLength.trim()
      || dp.maxOutput !== editModelForm.value.maxOutput.trim()
      || dp.concurrencyTarget !== editModelForm.value.concurrencyTarget.trim()
    if (changed) {
      let merged: Record<string, unknown>
      try {
        merged = JSON.parse(editModelForm.value.originalDefaultParams) as Record<string, unknown>
      }
      catch {
        merged = {}
      }
      const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v.trim()))
      const next: Record<string, unknown> = { ...merged }
      const cl = num(editModelForm.value.contextLength)
      const mo = num(editModelForm.value.maxOutput)
      const ct = num(editModelForm.value.concurrencyTarget)
      if (cl === undefined) delete next.context_length; else next.context_length = cl
      if (mo === undefined) delete next.max_output; else next.max_output = mo
      if (ct === undefined) delete next.concurrency_target; else next.concurrency_target = ct
      body.default_params = JSON.stringify(next)
    }
    await request(`/api/server/admin/models/${editModel.value.id}`, { method: 'PUT', body })
    editModel.value = null
    error.value = ''
    await load()
  }
  catch (e) {
    priceErr.value = (e as Error).message
  }
  finally {
    busy.value = null
  }
}

async function deleteModel(m: Model) {
  if (busy.value) return
  const hint = m.provider_channel
    ? '该模型由上游同步;删除后同步不会自动恢复,如需恢复请重新添加。'
    : '客户端建议清单将移除。'
  if (!window.confirm(`删除该模型?${hint}`)) return
  busy.value = `del-model-${m.id}`
  try {
    await request(`/api/server/admin/models/${m.id}`, { method: 'DELETE' })
    error.value = ''
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = null
  }
}

async function syncAll() {
  if (busy.value) return
  busy.value = 'sync-all'
  try {
    const r = await request<{ results?: SyncResult[] }>('/api/server/admin/providers/sync-all', { method: 'POST' })
    const results = r.results ?? []
    const skipped = results.filter((x) => x.skipped).length
    const active = results.filter((x) => !x.skipped)
    const parts: string[] = []
    const summary = active
      .map((x) => (x.error ? `${x.provider}: ${x.error}` : `${x.provider}: +${x.added}/-${x.removed}`))
      .filter(Boolean)
    if (summary.length) parts.push(summary.join('; '))
    if (skipped > 0) parts.push(`${skipped} 个手动型上游跳过`)
    syncMsg.value = parts.join('; ') || '同步完成,无变化'
    error.value = ''
    await load()
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = null
  }
}

function addPeak() {
  peakClearConfirmed.value = false
  peakList.value.push({ keyId: `pk-${uid()}`, start: '09:00', end: '12:00', weekdays: [1, 2, 3, 4, 5] })
}

function removePeak(i: number) {
  peakList.value = peakList.value.filter((_, idx) => idx !== i)
}

function presetPeak() {
  peakClearConfirmed.value = false
  peakList.value = [
    { keyId: `pk-${uid()}`, start: '09:00', end: '12:00', weekdays: [1, 2, 3, 4, 5] },
    { keyId: `pk-${uid()}`, start: '14:00', end: '18:00', weekdays: [1, 2, 3, 4, 5] },
  ]
}

function updatePeak(i: number, field: 'start' | 'end', v: string) {
  peakList.value = peakList.value.map((w, idx) => (idx === i ? { ...w, [field]: v } : w))
}

function togglePeakDay(i: number, d: number) {
  peakList.value = peakList.value.map((w, idx) => (
    idx === i
      ? { ...w, weekdays: w.weekdays.includes(d) ? w.weekdays.filter((x) => x !== d) : [...w.weekdays, d].sort((a, b) => a - b) }
      : w
  ))
}

onMounted(load)

const protocolItems = [
  { label: 'OpenAI 兼容(chat/completions、embeddings)', value: 'openai' },
  { label: 'Anthropic 兼容(/v1/messages,web 搜索)', value: 'anthropic' },
  { label: '共用(both:同一 key 双端点,chat+搜索)', value: 'both' },
]

const modalityItems = [
  { label: '仅文字', value: 'text' },
  { label: '文字 + 图片', value: 'image' },
]

const thinkingItems = [
  { label: 'max(最大思考)', value: 'max' },
  { label: 'high(高)', value: 'high' },
  { label: 'low(低)', value: 'low' },
  { label: 'off(关闭思考)', value: 'off' },
]

const unpricedItems = [
  { label: '拒绝请求(推荐)', value: 'reject' },
  { label: '允许使用(免费/内部模型)', value: 'allow' },
]

const defaultModelItems = computed(() =>
  models.value.map((m) => ({ label: `${m.display_name || m.name} (${m.name})`, value: m.name })),
)

const providerColumns = [
  { id: 'name', header: '名称' },
  { id: 'channel', header: '渠道' },
  { id: 'protocol', header: '协议' },
  { id: 'base_url', header: 'Base URL' },
  { id: 'api_key', header: 'API Key' },
  { id: 'models', header: '模型' },
  { id: 'enabled', header: '启用' },
  { id: 'actions', header: '操作' },
]

const modelColumns = [
  { id: 'name', header: '模型名' },
  { accessorKey: 'display_name', header: '显示名' },
  { id: 'provider', header: '上游' },
  { id: 'caps', header: '能力' },
  { id: 'pricing', header: '计费(元/百万 token)' },
  { id: 'actions', header: '操作' },
]

function isPriced(m: Model): boolean {
  return (m.input_price_per_1m ?? 0) > 0 || (m.output_price_per_1m ?? 0) > 0
}

function pricingText(m: Model): string {
  const input = m.input_price_per_1m ?? 0
  const output = m.output_price_per_1m ?? 0
  const cache = m.cache_input_price_per_1m ?? 0
  const offpeak = m.offpeak_discount ?? null
  let s = `入 ${input} / 出 ${output}`
  if (cache > 0) s += ` · 缓存 ${cache}`
  if (offpeak !== null && offpeak > 0 && offpeak < 1) s += ` · 谷 ${offpeak * 10}折`
  return s
}
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">网关配置</h1>
      <p class="text-sm text-neutral-500">上游接入与模型管理、限流配额与峰谷计费、客户端默认配置</p>
    </div>

    <UAlert
      v-if="error"
      title="出错了"
      :description="error"
      color="error"
      icon="i-lucide-triangle-alert"
      variant="soft"
    />
    <UAlert
      v-if="okMsg"
      title="成功"
      :description="okMsg"
      color="success"
      icon="i-lucide-circle-check"
      variant="soft"
    />
    <UAlert
      v-if="syncMsg"
      title="同步结果"
      :description="syncMsg"
      color="info"
      icon="i-lucide-refresh-cw"
      variant="soft"
    />
    <UAlert
      v-for="w in warnings"
      :key="w"
      title="提示"
      :description="w"
      color="warning"
      icon="i-lucide-triangle-alert"
      variant="soft"
    />

    <!-- ① 上游 Provider -->
    <UCard>
      <template #header>
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="font-medium">上游 Provider</div>
            <div class="text-sm text-neutral-500">LLM 上游密钥只存服务端(AES-GCM 加密);协议「共用(both)」时搜索与对话共用同一 key</div>
          </div>
          <UButton
            v-if="canWrite"
            size="sm"
            icon="i-lucide-plus"
            label="添加上游"
            :disabled="busy !== null"
            @click="provErr = ''; provDialog = true"
          />
        </div>
      </template>
      <UTable :data="providers" :columns="providerColumns" :loading="loading" empty="暂无上游,点击「添加上游」开始接入" class="w-full">
        <template #name-cell="{ row }">
          <div class="flex items-center gap-2">
            <span class="size-2 rounded-full" :class="row.original.enabled ? 'bg-green-500' : 'bg-slate-300'" />
            <span class="font-medium">{{ row.original.name }}</span>
          </div>
        </template>
        <template #channel-cell="{ row }">
          <UBadge v-if="row.original.channel" variant="soft">{{ row.original.channel }}</UBadge>
          <span v-else>—</span>
        </template>
        <template #protocol-cell="{ row }">
          <UBadge :variant="row.original.protocol === 'anthropic' ? 'outline' : 'soft'">
            {{ row.original.protocol === 'anthropic' ? 'Anthropic' : row.original.protocol === 'both' ? '共用' : 'OpenAI' }}
          </UBadge>
        </template>
        <template #base_url-cell="{ row }">
          <span class="font-mono text-xs text-neutral-500">{{ row.original.base_url }}</span>
        </template>
        <template #api_key-cell="{ row }">
          <div class="flex items-center gap-1">
            <template v-if="row.original.api_key">
              <UIcon name="i-lucide-lock" class="size-3.5 text-neutral-400" />
              <span class="text-xs">
                {{ row.original.api_key === '***' ? `••••••••••${row.original.channel ? ' (AES)' : ''}` : '••••••••••••••••(已配置)' }}
              </span>
            </template>
            <span v-else class="text-xs text-amber-600">未设置</span>
          </div>
        </template>
        <template #models-cell="{ row }">
          <span>{{ row.original.channel ? '自动同步' : row.original.models.join(', ') }}</span>
        </template>
        <template #enabled-cell="{ row }">
          <USwitch
            :model-value="row.original.enabled"
            :disabled="!canWrite"
            @update:model-value="toggleProviderEnabled(row.original, $event)"
          />
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center gap-1">
            <UButton
              v-if="canWrite"
              size="sm"
              variant="outline"
              label="编辑"
              :disabled="busy !== null"
              @click="openProviderEdit(row.original)"
            />
            <UButton
              v-if="canWrite"
              size="sm"
              variant="ghost"
              label="同步"
              :loading="busy === `sync-${row.original.id}`"
              :disabled="busy !== null && busy !== `sync-${row.original.id}`"
              @click="syncOne(row.original)"
            />
            <UButton
              size="sm"
              variant="ghost"
              label="余额"
              :disabled="busy !== null"
              @click="queryBalance(row.original)"
            />
            <UButton
              v-if="canWrite"
              size="sm"
              variant="ghost"
              color="error"
              label="删除"
              :disabled="busy !== null"
              @click="deleteProvider(row.original.id)"
            />
          </div>
        </template>
      </UTable>
    </UCard>

    <!-- ② 模型管理 -->
    <UCard>
      <template #header>
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="font-medium">模型管理</div>
            <div class="text-sm text-neutral-500">对客户端可见的模型列表(含已停用上游的模型,停用后客户端不可见)</div>
          </div>
          <div class="flex items-center gap-2">
            <UButton
              v-if="canWrite"
              size="sm"
              variant="outline"
              :loading="busy === 'sync-all'"
              :disabled="busy !== null && busy !== 'sync-all'"
              @click="syncAll"
            >
              {{ busy === 'sync-all' ? '同步中…' : '立即同步' }}
            </UButton>
            <UButton
              v-if="canWrite"
              size="sm"
              icon="i-lucide-plus"
              label="新增模型"
              :disabled="busy !== null"
              @click="modelErr = ''; modelDialog = true"
            />
          </div>
        </div>
      </template>
      <UTable :data="models" :columns="modelColumns" :loading="loading" empty="暂无模型,添加手动型上游或点击「立即同步」" class="w-full">
        <template #name-cell="{ row }">
          <div class="flex items-center gap-1">
            <span class="font-mono text-xs">{{ row.original.name }}</span>
            <UBadge v-if="(row.original.input_modalities ?? []).includes('image')" color="info" variant="soft">图片</UBadge>
          </div>
        </template>
        <template #provider-cell="{ row }">
          <div class="flex items-center gap-1">
            <span>{{ row.original.provider_name || '—' }}</span>
            <UBadge v-if="row.original.provider_enabled === false" color="warning" variant="soft">停用</UBadge>
          </div>
        </template>
        <template #caps-cell="{ row }">
          <span class="font-mono text-xs">{{ formatCaps(row.original.default_params) }}</span>
        </template>
        <template #pricing-cell="{ row }">
          <span v-if="isPriced(row.original)">{{ pricingText(row.original) }}</span>
          <UBadge v-else color="warning" variant="soft">未定价</UBadge>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center gap-1">
            <UButton
              v-if="canWrite"
              size="sm"
              variant="outline"
              label="配置"
              :disabled="busy !== null"
              @click="openModelPricing(row.original)"
            />
            <UButton
              v-if="canWrite"
              size="sm"
              variant="ghost"
              color="error"
              label="删除"
              :disabled="busy !== null"
              @click="deleteModel(row.original)"
            />
          </div>
        </template>
      </UTable>
    </UCard>

    <!-- ③ 全局设置 -->
    <UCard>
      <template #header>
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="font-medium">全局设置</div>
            <div class="text-sm text-neutral-500">随客户端启动配置下发,员工登录后自动应用</div>
          </div>
          <UButton
            v-if="canWrite"
            size="sm"
            :loading="busy === 'save-gateway'"
            :disabled="busy !== null || loading || !cfgLoaded"
            @click="saveGateway"
          >
            保存
          </UButton>
        </div>
      </template>

      <div v-if="loading" class="space-y-3">
        <USkeleton class="h-24 w-full" />
        <USkeleton class="h-24 w-full" />
        <USkeleton class="h-24 w-full" />
      </div>

      <div v-else-if="!cfgLoaded" class="text-sm text-red-600">
        全局设置未加载成功，保存已锁定（避免把空值当成新配置提交）——请刷新页面后重试
      </div>

      <fieldset v-else :disabled="!canWrite" class="space-y-6">
        <!-- 客户端默认 -->
        <section class="space-y-3">
          <h3 class="text-sm font-medium text-neutral-500">客户端默认</h3>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <UFormField label="默认模型" description="员工登录后的默认聊天模型">
              <USelect v-model="cfg.default_model" :items="defaultModelItems" placeholder="选择默认模型" />
            </UFormField>
            <UFormField label="默认思考强度" description="登录后默认模型自动使用该强度;用户可在模型选择器单独调整">
              <USelect v-model="cfg.default_thinking_level" :items="thinkingItems" />
            </UFormField>
          </div>
        </section>

        <!-- 网关防护 -->
        <section class="space-y-3">
          <h3 class="text-sm font-medium text-neutral-500">网关防护</h3>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <UFormField label="每用户网关限流(次/分钟)" description="0 = 不限制(与官方口径一致:官方只限账号级并发,不设请求速率上限)">
              <UInput v-model="cfg.rate_limit" type="number" />
            </UFormField>
            <UFormField label="单请求文件引用上限(个)" description="聊天请求里引用的 file_id 个数上限(超出 400);官方 vision 文档的单请求上限是 600 张图,缺省与之一致(归属校验只会更松,不会更严)">
              <UInput v-model="cfg.max_file_refs" type="number" />
            </UFormField>
            <UFormField label="文件保留上限(天)" description="员工上传的文件最长保留天数(1~30);客户端没带过期时间或要得更久都按该值收敛,超期由服务端在上游删除">
              <UInput v-model="cfg.file_expiry_days" type="number" />
            </UFormField>
            <UFormField
              label="未定价模型"
              description="没填价格(或填 0)的模型在余额闸门开启时怎么处理。「拒绝请求」是缺省:未定价模型的成本恒为 0 ⇒ 结算永远不会因余额不足失败、余额一分不减、闸门三层同时失效,账号可以无限次真实调用上游(组织付上游的钱、平台零计费零痕迹),所以缺省直接拒绝(429 MODEL_NOT_PRICED,不转发、不产生费用)。本组织确实有自建/免费模型时选「允许使用」——那种情况下费用才确实按 0 记。⚠️ 该策略是「全局」开关:同名模型挂在多个上游渠道、其中只有一家缺价时,「允许使用」也会放行落到那家的请求(那一次费用为 0)。要让「同一个模型处处计费」,请给缺价的渠道补价或停用它,而不是依赖这个开关。"
            >
              <USelect v-model="cfg.unpriced_model_policy" :items="unpricedItems" />
            </UFormField>
            <UFormField label="请求体加工内存预算(MiB)" description="全进程同时在解析的请求体总字节上限(超出 503 可重试);瞬时内存约为该值的 6~8 倍(实测),按可用内存设置;下限 64 = 一次只加工一个最大请求体">
              <UInput v-model="cfg.body_parse_budget_mb" type="number" />
            </UFormField>
          </div>
        </section>

        <!-- 用量策略 -->
        <section class="space-y-3">
          <h3 class="text-sm font-medium text-neutral-500">用量策略</h3>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <UFormField label="调用明细保留时长(月)" description="0 = 永不删除;超出保留期的明细分区被自动清理;日账/月账统计永久保留">
              <UInput v-model="cfg.retention_months" type="number" />
            </UFormField>
          </div>
        </section>

        <!-- 计费（峰谷 / 按次） -->
        <section class="space-y-3">
          <h3 class="text-sm font-medium text-neutral-500">计费（峰谷 / 按次）</h3>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <UFormField label="Search 按次计费(元/千次)" description="web_search 成功返回网页结果时按次收费,不参与峰谷折扣;0 = 不计费(缺省)。DeepSeek 官方 5 元/千次成功请求,2026-11-01 00:00(北京时间)起对 DeepSeek Harness / Claude Code / Codex 的 Server 端搜索开始计费。只统计网关 /v1/messages 的服务端搜索;客户端直连的 web_fetch 不经过此处,不计费。">
              <UInput v-model="cfg.search_price_per_1k" type="number" step="0.01" />
            </UFormField>
          </div>

          <div class="space-y-2">
            <span class="text-sm font-medium">高峰时段(北京时间)</span>
            <UAlert
              v-if="peakParseFailed"
              title="高峰时段配置无法解析"
              description="服务端已存的高峰时段配置无法解析(不是本页认得的 JSON 数组)。编辑区已置空,保存会被拒绝 —— 直接用空列表覆盖会静默清空峰谷窗口、改变计费口径。请用下方「添加时段」或预设按钮显式重建后再保存;若确认要放弃这份存量,请用「清空高峰时段配置」并二次确认。"
              color="error"
              icon="i-lucide-triangle-alert"
              variant="soft"
            />
            <UAlert
              v-if="peakParseFailed && peakClearConfirmed"
              title="已确认清空高峰时段"
              description="点击「保存」后服务端将写入空配置(无峰谷价,全天标准价)。"
              color="warning"
              icon="i-lucide-triangle-alert"
              variant="soft"
            />
            <div v-for="(w, i) in peakList" :key="w.keyId" class="flex flex-wrap items-center gap-2">
              <UInput
                v-model="w.start"
                type="time"
                class="w-40 shrink-0"
                :aria-label="`高峰开始 ${i + 1}`"
                @update:model-value="updatePeak(i, 'start', $event)"
              />
              <span class="text-xs text-neutral-500">至</span>
              <UInput
                v-model="w.end"
                type="time"
                class="w-40 shrink-0"
                :aria-label="`高峰结束 ${i + 1}`"
                @update:model-value="updatePeak(i, 'end', $event)"
              />
              <div class="flex items-center gap-0.5" :aria-label="`星期选择 ${i + 1}`">
                <button
                  v-for="(lbl, idx) in WEEKDAY_LABELS"
                  :key="idx"
                  type="button"
                  :aria-pressed="w.weekdays.includes(idx + 1)"
                  :aria-label="`周${lbl}`"
                  class="flex size-7 items-center justify-center rounded text-[11px] transition-colors"
                  :class="w.weekdays.includes(idx + 1)
                    ? 'bg-blue-600 font-semibold text-white'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200'"
                  @click="togglePeakDay(i, idx + 1)"
                >
                  {{ lbl }}
                </button>
              </div>
              <UButton size="sm" variant="outline" class="ml-2 shrink-0" @click="removePeak(i)">移除</UButton>
            </div>
            <div class="flex flex-wrap gap-2">
              <UButton size="sm" variant="outline" type="button" @click="addPeak">添加时段</UButton>
              <UButton size="sm" variant="outline" type="button" @click="presetPeak">DeepSeek 当前政策(工作日)</UButton>
              <UButton v-if="peakList.length > 0" size="sm" variant="ghost" type="button" @click="peakList = []">
                清空(无峰谷价)
              </UButton>
              <UButton
                v-if="peakParseFailed && !peakClearConfirmed"
                size="sm"
                color="error"
                variant="solid"
                type="button"
                @click="peakClearDialog = true"
              >
                清空高峰时段配置
              </UButton>
            </div>
            <ul class="space-y-1 text-xs text-neutral-500">
              <li>按北京时间判定,半开区间 [start,end);时段可勾选适用星期(周一…周日),未勾选 = 该天无峰谷。</li>
              <li>高峰窗口外(空闲时段)且模型配置了低谷折扣率时,费用按折扣率打折。</li>
              <li>清空 = 无峰谷价(全天标准价)。</li>
              <li>DeepSeek 官方当前政策(2026-08 起):高峰 = 北京时间<strong>周一至周五</strong> 09:00-12:00、14:00-18:00(其余为空闲,含周末),空闲价 = 高峰价 × 50%。</li>
            </ul>
          </div>
        </section>

        <!-- Web 工具 -->
        <section class="space-y-1">
          <h3 class="text-sm font-medium text-neutral-500">Web 工具</h3>
          <p class="text-xs text-neutral-500">
            web_search / web_fetch 已随客户端默认启用（web_search 走网关 /v1/messages 服务端代理,web_fetch 由客户端直连抓取网页,支持内网访问）。无需额外配置。
          </p>
        </section>

        <!-- 部署 -->
        <section class="space-y-3">
          <h3 class="text-sm font-medium text-neutral-500">部署</h3>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <UFormField label="对外访问地址 (Server Base URL)" description="客户端登录与员工访问入口(经 Caddy HTTPS 反代后的地址);填写后管理页顶部展示;清空保存可移除">
              <UInput v-model="cfg.server_base_url" type="url" placeholder="https://picoaide.example.com" />
            </UFormField>
          </div>
        </section>
      </fieldset>
    </UCard>

    <!-- 添加上游 -->
    <UModal v-model:open="provDialog" title="添加上游" :close="false">
      <template #body>
        <div class="space-y-3">
          <UAlert v-if="provErr" title="出错了" :description="provErr" color="error" icon="i-lucide-triangle-alert" variant="soft" />
          <UFormField label="渠道" description="渠道型(如 deepseek):模型自动从上游同步,无需手填;手动型:模型来自下方列表">
            <USelect :model-value="provForm.channel || MANUAL_CHANNEL" :items="channelItems" @update:model-value="onProvChannelChange" />
          </UFormField>
          <UFormField label="协议" description="Anthropic 协议上游供 web_search 走服务端代理使用(如 https://api.deepseek.com/anthropic/v1)">
            <USelect :model-value="provForm.protocol || 'openai'" :items="protocolItems" @update:model-value="provForm.protocol = $event" />
          </UFormField>
          <UFormField label="名称(如 deepseek)">
            <UInput v-model="provForm.name" />
          </UFormField>
          <UFormField label="Base URL(渠道型留空自动使用渠道默认地址)">
            <UInput
              v-model="provForm.base_url"
              type="url"
              :placeholder="provForm.channel ? channelBaseUrl(provForm.channel) : 'https://api.example.com'"
            />
          </UFormField>
          <UFormField :label="`API Key${provForm.channel ? '(必填)' : ''}`">
            <UInput v-model="provForm.api_key" type="password" placeholder="sk-..." />
          </UFormField>
          <UFormField label="模型(逗号分隔,渠道型自动同步无需填写)">
            <UInput
              v-model="provForm.models"
              :disabled="!!provForm.channel"
              :placeholder="provForm.channel ? '保存后自动同步' : 'deepseek-chat, deepseek-reasoner'"
            />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="outline" @click="provDialog = false">取消</UButton>
          <UButton :loading="busy === 'create-provider'" :disabled="busy !== null" @click="createProvider">添加</UButton>
        </div>
      </template>
    </UModal>

    <!-- 编辑上游 -->
    <UModal v-model:open="editProv" :title="`编辑上游 · ${editProv?.name ?? ''}`" :close="false">
      <template #body>
        <div class="space-y-3">
          <UAlert v-if="editProvErr" title="出错了" :description="editProvErr" color="error" icon="i-lucide-triangle-alert" variant="soft" />
          <UFormField label="渠道" description="渠道型自动同步上游模型,手动模型清单将被清空;手动型可维护模型列表">
            <USelect :model-value="editProvForm.channel || MANUAL_CHANNEL" :items="channelItems" @update:model-value="onEditProvChannelChange" />
          </UFormField>
          <UFormField label="协议">
            <USelect :model-value="editProvForm.protocol || 'openai'" :items="protocolItems" @update:model-value="editProvForm.protocol = $event" />
          </UFormField>
          <UFormField label="名称">
            <UInput v-model="editProvForm.name" />
          </UFormField>
          <UFormField label="Base URL">
            <UInput
              v-model="editProvForm.base_url"
              type="url"
              :placeholder="editProvForm.channel ? channelBaseUrl(editProvForm.channel) : 'https://api.example.com'"
            />
          </UFormField>
          <UFormField label="API Key(留空 = 不更换)">
            <UInput v-model="editProvForm.api_key" type="password" placeholder="sk-..." />
          </UFormField>
          <UFormField label="模型(逗号分隔,渠道型自动同步无需填写)">
            <UInput
              v-model="editProvForm.models"
              :disabled="!!editProvForm.channel"
              :placeholder="editProvForm.channel ? '保存后自动同步' : 'deepseek-chat, deepseek-reasoner'"
            />
            <p
              v-if="editModelsChanged"
              class="mt-1 text-xs text-red-600"
            >
              模型清单已修改:移出清单的模型会被删除(含其价格与参数配置);仍在清单中的模型,价格/参数/输入模态保持不变。
            </p>
          </UFormField>
          <USwitch v-model="editProvForm.enabled" label="启用该上游(停用后不参与模型路由,但模型仍可在本页管理)" />
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="outline" @click="editProv = null">取消</UButton>
          <UButton :loading="busy === 'save-provider-edit'" :disabled="busy !== null" @click="saveProviderEdit">保存</UButton>
        </div>
      </template>
    </UModal>

    <!-- 新增模型 -->
    <UModal v-model:open="modelDialog" title="新增模型" :close="false">
      <template #body>
        <div class="space-y-3">
          <UAlert v-if="modelErr" title="出错了" :description="modelErr" color="error" icon="i-lucide-triangle-alert" variant="soft" />
          <UFormField label="模型名(如 deepseek-chat)">
            <UInput v-model="modelForm.name" />
          </UFormField>
          <UFormField label="显示名">
            <UInput v-model="modelForm.display_name" />
          </UFormField>
          <UFormField label="所属上游">
            <USelect :model-value="modelForm.provider_id" :items="providerItems" placeholder="选择上游" @update:model-value="onModelProviderChange" />
          </UFormField>
          <UFormField label="输入模态(0058:客户端据此允许图片上传)">
            <USelect v-model="modelForm.input_modalities" :items="modalityItems" />
          </UFormField>
          <div class="grid grid-cols-2 gap-3">
            <UFormField label="输入价格(元/百万 token)">
              <UInput v-model="modelForm.input_price_per_1m" type="number" step="0.01" placeholder="留空 = 未定价" />
            </UFormField>
            <UFormField label="输出价格(元/百万 token)">
              <UInput v-model="modelForm.output_price_per_1m" type="number" step="0.01" placeholder="留空 = 未定价" />
            </UFormField>
            <UFormField label="缓存命中输入价(元/百万 token)" description="命中 token 按此价计费(不是展示项);留空或填 0 = 未配置,回退按输入价计费。DeepSeek V4 官方缓存命中价约为输入价的 2%~3.3%(Flash 0.04/2、Pro 0.30/9,高峰价),不填会把命中部分按输入价多算几十倍。">
              <UInput v-model="modelForm.cache_input_price_per_1m" type="number" step="0.01" placeholder="留空 = 未配置(按输入价计费)" />
            </UFormField>
            <UFormField label="低谷折扣率(0-1,留空 = 无峰谷价)">
              <UInput v-model="modelForm.offpeak_discount" type="number" min="0" max="1" step="0.05" placeholder="DeepSeek 官方错峰五折 = 0.5" />
            </UFormField>
          </div>
          <ul class="space-y-1 text-xs text-neutral-500">
            <li>配置价格后,用量页按 未命中输入token×输入价 + 命中输入token×缓存价 + 输出token×输出价 折算费用;未配置价格(或填 0)的模型在缺省策略下会被拒绝调用(429 MODEL_NOT_PRICED,不转发也不产生费用)—— 确实免费/自建时把「未定价模型策略」改成「允许使用」,那时费用才按 0 记。</li>
            <li>低谷折扣:配置「全局设置 → 高峰时段」后,高峰窗口外(空闲时段)费用 × 折扣率,高峰时段按标准价。</li>
            <li>DeepSeek 官方错峰五折(2026-08 起):高峰 = 北京周一至周五 09:00-12:00、14:00-18:00,空闲价 = 高峰价 × 50%。</li>
          </ul>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="outline" @click="modelDialog = false">取消</UButton>
          <UButton :loading="busy === 'create-model'" :disabled="busy !== null" @click="createModel">新增</UButton>
        </div>
      </template>
    </UModal>

    <!-- 模型编辑（价格/参数） -->
    <UModal v-model:open="editModel" :title="`模型编辑 · ${editModel?.name ?? ''}`" :close="false">
      <template #body>
        <div class="space-y-3">
          <UAlert v-if="priceErr" title="出错了" :description="priceErr" color="error" icon="i-lucide-triangle-alert" variant="soft" />
          <UFormField label="显示名">
            <UInput v-model="editModelForm.displayName" placeholder="留空 = 保持现值" />
          </UFormField>
          <UFormField label="所属上游">
            <USelect v-model="editModelForm.providerId" :items="providerItems" placeholder="保持现值" />
          </UFormField>
          <div class="grid grid-cols-3 gap-3">
            <UFormField label="上下文窗口(token)">
              <UInput v-model="editModelForm.contextLength" type="number" min="1" placeholder="如 131072" />
            </UFormField>
            <UFormField label="最大输出 token 数">
              <UInput v-model="editModelForm.maxOutput" type="number" min="1" placeholder="如 64000" />
            </UFormField>
            <UFormField label="并发目标(参考)">
              <UInput v-model="editModelForm.concurrencyTarget" type="number" min="1" placeholder="如 100" />
            </UFormField>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <UFormField label="输入价格(元/百万 token)">
              <UInput v-model="editModelForm.input" type="number" step="0.01" placeholder="留空 = 保持现值" />
            </UFormField>
            <UFormField label="输出价格(元/百万 token)">
              <UInput v-model="editModelForm.output" type="number" step="0.01" placeholder="留空 = 保持现值" />
            </UFormField>
            <UFormField label="缓存命中输入价(元/百万 token)">
              <UInput v-model="editModelForm.cache" type="number" step="0.01" placeholder="留空 = 保持现值" />
            </UFormField>
            <UFormField label="低谷折扣率(0-1,留空 = 保持现值;1 = 取消峰谷)">
              <UInput v-model="editModelForm.offpeak" type="number" min="0" max="1" step="0.05" placeholder="留空 = 保持现值" />
            </UFormField>
          </div>
          <UFormField label="输入模态">
            <USelect v-model="editModelForm.modalities" :items="modalityItems" />
          </UFormField>
          <p class="text-xs text-neutral-500">
            修改价格/折扣只影响之后产生的用量费用(历史费用按记录时定价留存)。低谷折扣 = 高峰窗口外(空闲时段)费用 × 折扣率;需先在「全局设置」配置高峰时段。DeepSeek 官方:高峰 = 北京 09:00-12:00、14:00-18:00,空闲价 = 高峰价 × 50%。
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="outline" @click="editModel = null">取消</UButton>
          <UButton :loading="busy === 'save-model-pricing'" :disabled="busy !== null" @click="saveModelPricing">保存</UButton>
        </div>
      </template>
    </UModal>

    <!-- 清空高峰时段配置确认 -->
    <UModal v-model:open="peakClearDialog" title="确认清空高峰时段配置?" :close="false">
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-neutral-600">
            服务端当前保存的高峰时段配置无法被本页解析(可能是旧版本写入或人工改动过)。
            清空后保存会把峰谷窗口写成空值 —— 即<strong>没有高峰时段,全天按标准价计费</strong>。
            这个操作会改变计费口径,且原配置在这里显示不出来、无法还原。
          </p>
          <p class="text-sm text-neutral-500">
            如果只是想继续用峰谷价,请点「取消」,改用「添加时段」或「DeepSeek 当前政策(工作日)」重建后再保存。
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton variant="outline" @click="peakClearDialog = false">取消</UButton>
          <UButton
            color="error"
            variant="solid"
            @click="peakList = []; peakClearConfirmed = true; peakClearDialog = false; error = ''"
          >
            确认清空
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- 上游余额 -->
    <UModal v-model:open="balanceDialog" :title="`上游余额 · ${balanceProvName}`" :close="true">
      <template #body>
        <div v-if="balanceLoading" class="text-sm text-neutral-500">查询中…</div>
        <div v-else-if="balanceErr" class="text-sm text-red-600">{{ balanceErr }}</div>
        <div v-else-if="balance && balance.supported === false" class="text-sm text-neutral-500">该上游不支持余额查询</div>
        <div v-else-if="balance && balance.is_available === false" class="text-sm text-red-600">
          {{ balance.error || '余额不可用' }}
        </div>
        <div v-else-if="balance && balance.infos && balance.infos.length > 0" class="space-y-3">
          <div v-for="(info, i) in balance.infos" :key="i" class="space-y-2 rounded-md border border-neutral-200 p-3">
            <div class="flex justify-between text-sm">
              <span class="text-neutral-500">币种</span>
              <span class="font-medium">{{ info.currency }}</span>
            </div>
            <div class="flex justify-between text-sm">
              <span class="text-neutral-500">总余额</span>
              <span class="font-medium tabular-nums">{{ info.total_balance }}</span>
            </div>
            <div class="flex justify-between text-sm">
              <span class="text-neutral-500">赠金</span>
              <span class="font-medium tabular-nums">{{ info.granted_balance }}</span>
            </div>
            <div class="flex justify-between text-sm">
              <span class="text-neutral-500">充值</span>
              <span class="font-medium tabular-nums">{{ info.topped_up_balance }}</span>
            </div>
          </div>
          <p v-if="balance.fetched_at" class="text-xs text-neutral-400">查询时间: {{ balance.fetched_at }}</p>
        </div>
        <div v-else class="text-sm text-neutral-500">无余额数据</div>
      </template>
    </UModal>
  </div>
</template>
