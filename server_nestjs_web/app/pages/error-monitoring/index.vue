<script setup lang="ts">
import { type SessionUser } from '~/lib/nav'
import { inspectErrorReportingDsn } from '~/lib/dsn'

interface ErrorReportingClientStatus {
  username: string
  state: string
  reason: string
  dsn_host: string
  level: string
  release: string
  updated_at: string
}

interface ErrorReportingClientsPayload {
  ready?: number
  disabled?: number
  failed?: number
  config_unavailable?: number
  idle?: number
  total?: number
  last_report_at?: string | null
  items?: ErrorReportingClientStatus[]
}

const EMPTY_CLIENTS: ErrorReportingClientsPayload = { total: 0, items: [] }

const STATE_LABELS: Record<string, string> = {
  ready: '已启用',
  disabled: '未启用',
  failed: '初始化失败',
  config_unavailable: '配置不可用',
  idle: '未上报',
}

function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

const { request } = useApi()
const { data: authData } = useAuth()
const user = computed<SessionUser | null>(() => (authData.value as SessionUser | null) ?? null)
const canWrite = computed(() => user.value?.permissions?.includes('gateway:write') ?? false)

const cfg = ref({
  error_reporting_enabled: false,
  error_reporting_dsn: '',
  error_reporting_level: 'error',
  error_reporting_heartbeat: false,
  glitchtip_base_url: '',
  glitchtip_organization: '',
})

const loading = ref(true)
const error = ref('')
const okMsg = ref('')
const busy = ref(false)
const warnings = ref<string[]>([])
const testBusy = ref(false)
const testOk = ref('')
const testErr = ref('')
const clients = ref<ErrorReportingClientsPayload>(EMPTY_CLIENTS)
const clientsError = ref('')
const clientsLoaded = ref(false)
const cfgLoaded = ref(false)

const inspection = computed(() => inspectErrorReportingDsn(cfg.value.error_reporting_dsn))
const failedItems = computed(() =>
  (clients.value.items ?? []).filter((item) => item.state === 'failed' || item.state === 'config_unavailable'),
)
const hasClientData = computed(() => (clients.value.total ?? 0) > 0)

const levelItems = [
  { label: 'debug(全部)', value: 'debug' },
  { label: 'info(debug+info)', value: 'info' },
  { label: 'warning(含 error)', value: 'warning' },
  { label: 'error(仅错误)', value: 'error' },
]

async function load() {
  loading.value = true
  error.value = ''
  try {
    const g = await request<Record<string, unknown>>('/api/server/admin/gateway')
    cfg.value = {
      error_reporting_enabled: g.error_reporting_enabled === true,
      error_reporting_dsn: (g.error_reporting_dsn as string) ?? '',
      error_reporting_level: (g.error_reporting_level as string) ?? 'error',
      error_reporting_heartbeat: g.error_reporting_heartbeat === true,
      glitchtip_base_url: (g.glitchtip_base_url as string) ?? '',
      glitchtip_organization: (g.glitchtip_organization as string) ?? '',
    }
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

async function loadClients() {
  clientsError.value = ''
  try {
    const data = await request<ErrorReportingClientsPayload>('/api/server/admin/gateway/error-reporting/clients')
    clients.value = data ?? EMPTY_CLIENTS
    clientsLoaded.value = true
  }
  catch (e) {
    clientsError.value = (e as Error).message
    clientsLoaded.value = false
  }
}

async function save() {
  if (busy.value) return
  error.value = ''
  warnings.value = []
  const verdict = inspectErrorReportingDsn(cfg.value.error_reporting_dsn)
  if (verdict.verdict === 'reject') {
    error.value = verdict.message
    return
  }
  if (cfg.value.error_reporting_enabled && cfg.value.error_reporting_dsn.trim() === '') {
    error.value = '启用客户端错误上报时必须填写 DSN:开关打开而 DSN 为空时客户端不会上报任何错误'
    return
  }
  if (cfg.value.glitchtip_base_url && !/^https?:\/\//i.test(cfg.value.glitchtip_base_url.trim())) {
    error.value = 'GlitchTip 服务地址必须是 http(s) URL(或留空)'
    return
  }
  busy.value = true
  try {
    const res = await request<{ warnings?: unknown }>('/api/server/admin/gateway', {
      method: 'PUT',
      body: {
        error_reporting_enabled: cfg.value.error_reporting_enabled,
        error_reporting_dsn: cfg.value.error_reporting_dsn.trim(),
        error_reporting_level: cfg.value.error_reporting_level,
        error_reporting_heartbeat: cfg.value.error_reporting_heartbeat,
        glitchtip_base_url: cfg.value.glitchtip_base_url.trim(),
        glitchtip_organization: cfg.value.glitchtip_organization.trim(),
      },
    })
    warnings.value = Array.isArray(res?.warnings) ? res.warnings.filter((w: unknown) => typeof w === 'string') : []
    okMsg.value = '已保存'
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = false
  }
}

async function sendTestEvent() {
  if (testBusy.value) return
  testOk.value = ''
  testErr.value = ''
  const verdict = inspectErrorReportingDsn(cfg.value.error_reporting_dsn)
  if (verdict.verdict === 'reject') {
    testErr.value = verdict.message
    return
  }
  testBusy.value = true
  try {
    const res = await request<{ event_id?: string; http_status?: number; elapsed_ms?: number; note?: string }>(
      '/api/server/admin/gateway/error-reporting/test',
      { method: 'POST', body: { dsn: cfg.value.error_reporting_dsn.trim() } },
    )
    const eventId = String(res?.event_id ?? '')
    testOk.value =
      `测试事件已发送(event_id ${eventId.slice(0, 8)}…,HTTP ${res?.http_status ?? '?'},${res?.elapsed_ms ?? '?'}ms)。`
      + `${res?.note ? ` ${res.note}` : ''}`
  }
  catch (e) {
    const err = e as Error & { detail?: { kind?: string } }
    testErr.value = err?.detail?.kind ? `${err.message}(${err.detail.kind})` : err.message
  }
  finally {
    testBusy.value = false
  }
}

onMounted(() => {
  load()
  loadClients()
})
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">错误监控</h1>
      <p class="text-sm text-neutral-500">客户端错误上报与 GlitchTip 连接器预填：登录自动应用，无需用户手动连接</p>
    </div>

    <UCard title="客户端错误上报" description="开关 + DSN + 等级，随客户端配置下发（登录自动启用）">
      <div v-if="loading" class="text-sm text-neutral-500">加载中…</div>
      <div
        v-else-if="!cfgLoaded"
        class="text-sm text-red-600"
      >
        配置未加载成功，表单与保存已锁定（避免把"未启用 + 空 DSN"当成新配置写回，那会关掉错误上报并抹掉 DSN）——请重新加载页面重试。
      </div>
      <div v-else class="space-y-4">
        <USwitch
          v-model="cfg.error_reporting_enabled"
          label="启用客户端错误上报（未捕获异常/未处理 rejection）"
          :disabled="!canWrite"
        />

        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div class="space-y-1">
            <UFormField label="错误上报 DSN（客户端 Sentry 上报地址，如 GlitchTip）">
              <UInput
                v-model="cfg.error_reporting_dsn"
                type="text"
                placeholder="https://glitchtip.example.com/...或空=不启用"
                :disabled="!canWrite"
              />
            </UFormField>
            <p v-if="cfg.error_reporting_dsn.trim() !== '' && inspection.host !== ''" class="text-xs text-neutral-500">
              主机: {{ inspection.host }} / 项目 ID: {{ inspection.projectId }}
            </p>
            <p v-if="inspection.verdict === 'warn'" class="text-xs text-amber-700">{{ inspection.message }}</p>
            <p v-if="inspection.verdict === 'reject'" class="text-xs text-red-600">{{ inspection.message }}</p>
          </div>
          <div class="space-y-1">
            <UFormField label="上报等级（>= 该等级才上报）">
              <USelect
                v-model="cfg.error_reporting_level"
                :items="levelItems"
                :disabled="!canWrite"
              />
            </UFormField>
          </div>
        </div>

        <div class="space-y-1">
          <USwitch
            v-model="cfg.error_reporting_heartbeat"
            label="启动时发送链路心跳（证明上报链路存活）"
            :disabled="!canWrite"
          />
          <p class="text-xs text-neutral-500">
            开启后，每个客户端每次启动上报一条 info 级「链路心跳」——该条**不受上面的上报等级阈值限制**，
            仅用于证明链路存活；介意噪音时保持关闭。
          </p>
        </div>

        <p class="text-xs text-neutral-500">
          开关开启 + DSN 非空时，客户端登录后自动启用错误上报（无需用户手动连接）；
          等级阈值：如 warning = 上报 warning 与 error。仅支持 Sentry 兼容服务（如自托管 GlitchTip）。
          指向本机/云元数据地址（如 localhost）的 DSN 会被拒绝 —— 客户端会把事件发往它自己的电脑，永远收不到。
        </p>

        <div v-if="canWrite" class="flex items-center gap-3">
          <UButton variant="outline" :loading="testBusy" @click="sendTestEvent">
            {{ testBusy ? '发送中…' : '发送测试事件' }}
          </UButton>
          <span class="text-xs text-neutral-500">
            由**服务端**代发一条测试事件，证明服务端到上报地址可达；员工客户端的网络环境可能不同。
          </span>
        </div>
        <UAlert
          v-if="testOk"
          title="发送成功"
          :description="testOk"
          color="success"
          icon="i-lucide-circle-check"
          variant="soft"
        />
        <UAlert
          v-if="testErr"
          title="发送失败"
          :description="testErr"
          color="error"
          icon="i-lucide-triangle-alert"
          variant="soft"
        />
      </div>
    </UCard>

    <UCard title="客户端上报状态" description="客户端登录后回报自身的错误上报初始化结果（最近 100 台）">
      <div class="space-y-3">
        <UAlert
          v-if="clientsError"
          title="状态加载失败"
          :description="clientsError"
          color="error"
          icon="i-lucide-triangle-alert"
          variant="soft"
        />
        <div v-if="clientsLoaded" class="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div>已启用上报: <span class="font-medium">{{ clients.ready ?? 0 }}</span> 台</div>
          <div>初始化失败: <span class="font-medium text-red-600">{{ clients.failed ?? 0 }}</span> 台</div>
          <div>未启用: <span class="font-medium">{{ clients.disabled ?? 0 }}</span> 台</div>
          <div>配置不可用: <span class="font-medium">{{ clients.config_unavailable ?? 0 }}</span> 台</div>
        </div>
        <p v-if="clientsLoaded" class="text-xs text-neutral-500">最近一次上报: {{ formatTime(clients.last_report_at) }}</p>
        <p v-if="!clientsLoaded && !clientsError" class="text-sm text-neutral-500">客户端上报状态加载中…</p>

        <UAlert
          v-if="clientsLoaded && !hasClientData && !clientsError"
          title="尚无客户端上报状态"
          description="这不代表链路正常：客户端只有登录并完成一次错误上报初始化后才会回报；请确认上报开关已开启且客户端版本包含状态上报能力。"
          color="warning"
          icon="i-lucide-triangle-alert"
          variant="soft"
        />

        <div v-if="failedItems.length > 0" class="space-y-1">
          <p class="text-sm font-medium">失败明细</p>
          <ul class="space-y-1 text-xs">
            <li v-for="item in failedItems" :key="`${item.username}-${item.updated_at}`" class="text-red-600">
              {{ item.username }}({{ stateLabel(item.state) }}): {{ item.reason || '未提供原因' }} · {{ formatTime(item.updated_at) }}
            </li>
          </ul>
        </div>

        <div class="flex justify-end">
          <UButton variant="ghost" size="sm" :loading="!clientsLoaded && !clientsError" @click="loadClients">
            刷新状态
          </UButton>
        </div>
      </div>
    </UCard>

    <UCard title="GlitchTip 连接器预填" description="客户端连接器自动预填服务地址与组织，用户只需填 API Token">
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div class="space-y-1">
          <UFormField label="GlitchTip 服务地址（连接器预填）">
            <UInput
              v-model="cfg.glitchtip_base_url"
              type="text"
              placeholder="https://glitchtip.example.com 或空=不预填"
              :disabled="!canWrite"
            />
          </UFormField>
          <p class="text-xs text-neutral-500">客户端连接器自动预填，用户只需填 API Token</p>
        </div>
        <div class="space-y-1">
          <UFormField label="GlitchTip 组织 slug（连接器预填）">
            <UInput
              v-model="cfg.glitchtip_organization"
              type="text"
              placeholder="如 picoaide 或空=不预填"
              :disabled="!canWrite"
            />
          </UFormField>
        </div>
      </div>
    </UCard>

    <div class="flex items-center justify-end gap-3">
      <span v-if="!loading && !cfgLoaded" class="text-xs text-red-600">配置未加载成功，保存已锁定</span>
      <span v-if="cfgLoaded && !canWrite" class="text-xs text-neutral-400">只读：缺少 gateway:write 权限</span>
      <UButton :loading="busy" :disabled="busy || !cfgLoaded || !canWrite" @click="save">
        {{ busy ? '保存中…' : '保存' }}
      </UButton>
    </div>
  </div>
</template>
