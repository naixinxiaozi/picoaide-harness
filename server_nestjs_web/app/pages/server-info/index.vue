<script setup lang="ts">
interface SysInfo {
  uptime_sec: number
  uptime_human: string
  go_version: string
  num_cpu: number
  gomaxprocs: number
  goroutines: number
  mem: { allocated_mb: number; total_system_mb: number; system_memory_mb: number }
  load_avg: [number, number, number]
  disk: { data_path: string; total_gb: number; used_gb: number; free_gb: number; used_pct: number }
  db: {
    driver: string
    tables: Record<string, number>
    total_rows: number
    disk_bytes: number
    disk_human: string
    schema_migrations: number
  }
  version: string
  balance?: {
    admission_rejections: number
    last_rejection?: {
      user_id: number
      username: string
      endpoint: string
      model: string
      reason: string
      required_money: number
      balance_money: number
      at: string
    } | null
  }
  audit?: {
    chain_checked: boolean
    chain_intact: boolean
    chain_broken_id: number
    chain_checked_at?: string
    chain_age_seconds: number
    chain_stale: boolean
    chain_source?: string
    chain_checks: number
    chain_rows: number
    chain_duration_ms: number
    chain_error?: string
    write_failures: number
    dropped_entries: number
    retries: number
    last_failure?: {
      reason: string
      action: string
      username: string
      cause: string
      cause_class: string
      at: string
    } | null
  }
  update_check?: {
    current: string
    latest: string
    update_available: boolean
    image_tag?: string
    manifest_url?: string
    checked_at: string
  } | null
}

interface ConcurrencyStatus {
  checked_at: string
  models: Array<{ model: string; current: number; peak_90d: number; target: number; provider?: string }>
}

const { request } = useApi()

const loading = ref(true)
const error = ref('')
const info = ref<SysInfo | null>(null)
const conc = ref<ConcurrencyStatus | null>(null)

function numOrDash(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '—'
}
function rawCountOrDash(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—'
}

function chainVerdictText(audit: SysInfo['audit']): string {
  if (!audit) return '—'
  if (!audit.chain_checked) return '尚未校验'
  if (typeof audit.chain_intact !== 'boolean') return '—'
  if (audit.chain_intact) return '完整'
  if (typeof audit.chain_broken_id !== 'number' || !Number.isFinite(audit.chain_broken_id)) {
    return '断链（位置未知）'
  }
  return `断链于 id=${audit.chain_broken_id}`
}

function chainFreshnessText(audit: SysInfo['audit']): string {
  if (!audit) return '—'
  if (typeof audit.chain_stale !== 'boolean') return '—'
  const age = typeof audit.chain_age_seconds === 'number' ? `${audit.chain_age_seconds} 秒前` : '未知时间'
  return audit.chain_stale ? `已过期（${age}）` : `有效（${age}）`
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [d, c] = await Promise.all([
      request<SysInfo>('/api/server/admin/server-info'),
      request<ConcurrencyStatus>('/api/server/admin/concurrency').catch(() => null),
    ])
    info.value = d
    conc.value = c
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    loading.value = false
  }
}

onMounted(load)

const tableRows = computed(() => {
  if (!info.value) return [] as Array<{ name: string; rows: string }>
  return Object.entries(info.value.db.tables).map(([name, rows]) => ({
    name,
    rows: rows.toLocaleString(),
  }))
})

const tableColumns = [
  { accessorKey: 'name', header: '表' },
  { accessorKey: 'rows', header: '行数' },
]

const concColumns = [
  { accessorKey: 'model', header: '模型' },
  { accessorKey: 'current', header: '当前并发' },
  { accessorKey: 'peak_90d', header: '90 天峰值' },
  { accessorKey: 'target', header: '目标' },
  { id: 'util', header: '峰值利用率' },
]

const concRows = computed(() => {
  if (!conc.value) return [] as Array<{ model: string; current: string; peak_90d: string; target: string; util: string; exceeding: boolean }>
  return conc.value.models.map((m) => {
    const target = m.target > 0 ? String(m.target) : '未配置'
    const util = m.target > 0 ? `${((m.peak_90d / m.target) * 100).toFixed(0)}%` : '—'
    return {
      model: m.model,
      current: String(m.current),
      peak_90d: String(m.peak_90d),
      target,
      util,
      exceeding: m.target > 0 && m.peak_90d >= m.target,
    }
  })
})
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-6">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">服务器信息</h1>
        <p class="text-sm text-neutral-500">系统运行状态与数据库统计（独立于业务数据，仅管理员可见）</p>
      </div>
      <UButton icon="i-lucide-refresh-cw" variant="outline" :loading="loading" @click="load">
        刷新
      </UButton>
    </div>

    <UAlert
      v-if="error"
      title="加载失败"
      :description="error"
      color="error"
      icon="i-lucide-triangle-alert"
      variant="soft"
    />

    <div v-if="loading" class="space-y-4">
      <USkeleton class="h-24 w-full" />
      <USkeleton class="h-40 w-full" />
      <USkeleton class="h-40 w-full" />
    </div>

    <template v-else-if="info">
      <UAlert
        v-if="info.update_check?.update_available"
        :title="`发现新版本 ${info.update_check.latest}（当前 v${info.version}）`"
        color="info"
        icon="i-lucide-circle-arrow-up"
        variant="soft"
      >
        <template #description>
          <div class="space-y-1">
            <span v-if="info.update_check.image_tag">镜像 tag：<code>{{ info.update_check.image_tag }}</code></span>
            <div v-if="info.update_check.manifest_url">
              <ULink :to="info.update_check.manifest_url" target="_blank" external>查看更新信息</ULink>
            </div>
          </div>
        </template>
      </UAlert>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <UCard>
          <div class="flex items-center gap-3">
            <UIcon name="i-lucide-clock" class="size-5 text-neutral-400" />
            <div>
              <div class="text-sm text-neutral-500">运行时长</div>
              <div class="font-medium tabular-nums">{{ info.uptime_human }}</div>
              <div class="text-xs text-neutral-400">版本 {{ info.version }}</div>
            </div>
          </div>
        </UCard>

        <UCard>
          <div class="flex items-center gap-3">
            <UIcon name="i-lucide-cpu" class="size-5 text-neutral-400" />
            <div>
              <div class="text-sm text-neutral-500">CPU 与负载</div>
              <div class="font-medium tabular-nums">{{ info.num_cpu }} 核</div>
              <div class="text-xs text-neutral-400 tabular-nums">
                负载 {{ info.load_avg[0].toFixed(2) }} / {{ info.load_avg[1].toFixed(2) }} / {{ info.load_avg[2].toFixed(2) }} · GOMAXPROCS {{ info.gomaxprocs }}
              </div>
            </div>
          </div>
        </UCard>

        <UCard>
          <div class="flex items-center gap-3">
            <UIcon name="i-lucide-memory-stick" class="size-5 text-neutral-400" />
            <div>
              <div class="text-sm text-neutral-500">内存 Go 堆</div>
              <div class="font-medium tabular-nums">{{ info.mem.allocated_mb }} MB</div>
              <div class="text-xs text-neutral-400 tabular-nums">
                系统 {{ info.mem.system_memory_mb }} MB · 进程占用 {{ info.mem.total_system_mb }} MB
              </div>
            </div>
          </div>
        </UCard>

        <UCard>
          <div class="flex items-center gap-3">
            <UIcon name="i-lucide-hard-drive" class="size-5 text-neutral-400" />
            <div>
              <div class="text-sm text-neutral-500">磁盘占用</div>
              <div class="font-medium tabular-nums">{{ info.disk.used_gb }} / {{ info.disk.total_gb }} GB</div>
              <div class="text-xs text-neutral-400 tabular-nums">
                使用率 {{ info.disk.used_pct }}% · 剩余 {{ info.disk.free_gb }} GB
              </div>
            </div>
          </div>
        </UCard>
      </div>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard title="系统详情">
          <div class="space-y-2 text-sm">
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">Go 运行时</span>
              <span class="font-medium tabular-nums">{{ info.go_version }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">Goroutines</span>
              <span class="font-medium tabular-nums">{{ info.goroutines }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">GOMAXPROCS</span>
              <span class="font-medium tabular-nums">{{ info.gomaxprocs }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">数据库引擎</span>
              <span class="font-medium">{{ info.db.driver === 'pg' ? 'PostgreSQL' : info.db.driver }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">数据库大小</span>
              <span class="font-medium tabular-nums">{{ info.db.disk_human }} ({{ info.db.disk_bytes.toLocaleString() }} B)</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">Schema 迁移版本</span>
              <span class="font-medium tabular-nums">{{ info.db.schema_migrations }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">数据目录</span>
              <span class="font-mono text-xs">{{ info.disk.data_path }}</span>
            </div>
          </div>
        </UCard>

        <UCard :title="'数据表统计'" :description="`各表行数（共 ${info.db.total_rows.toLocaleString()} 行）`">
          <UTable :data="tableRows" :columns="tableColumns" class="w-full" />
        </UCard>
      </div>

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <UCard title="余额闸门准入" description="余额不足的请求在转发上游之前被拒，避免产生无法结算的费用">
          <div class="space-y-2 text-sm">
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">累计拒绝次数</span>
              <span class="font-medium tabular-nums">{{ numOrDash(info.balance?.admission_rejections) }}</span>
            </div>
            <template v-if="info.balance?.last_rejection">
              <div class="flex justify-between gap-4">
                <span class="text-neutral-500">最近被拒账号</span>
                <span class="font-medium">{{ info.balance.last_rejection.username || '—' }}</span>
              </div>
              <div class="flex justify-between gap-4">
                <span class="text-neutral-500">端点 / 模型</span>
                <span class="font-medium">{{ info.balance.last_rejection.endpoint || '—' }} · {{ info.balance.last_rejection.model || '—' }}</span>
              </div>
              <div class="flex justify-between gap-4">
                <span class="text-neutral-500">拒绝依据</span>
                <span class="font-medium">{{ info.balance.last_rejection.reason || '—' }}</span>
              </div>
              <div class="flex justify-between gap-4">
                <span class="text-neutral-500">要求金额 / 当时余额</span>
                <span class="font-medium tabular-nums">{{ info.balance.last_rejection.required_money }} / {{ info.balance.last_rejection.balance_money }} 元</span>
              </div>
              <div class="flex justify-between gap-4">
                <span class="text-neutral-500">发生时刻</span>
                <span class="font-medium">{{ info.balance.last_rejection.at || '—' }}</span>
              </div>
            </template>
            <div v-else class="text-sm text-neutral-400">最近被拒记录 —</div>
          </div>
        </UCard>

        <UCard title="审计健康" description="哈希链校验结论的新鲜度与审计写入缺口（防篡改）">
          <div class="space-y-2 text-sm">
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">链校验结论</span>
              <span class="font-medium">{{ chainVerdictText(info.audit) }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">结论新鲜度</span>
              <span class="font-medium">{{ chainFreshnessText(info.audit) }}</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">校验执行者 · 次数</span>
              <span class="font-medium tabular-nums">{{ info.audit?.chain_source || '—' }} · {{ rawCountOrDash(info.audit?.chain_checks) }} 次 · 扫描 {{ rawCountOrDash(info.audit?.chain_rows) }} 行</span>
            </div>
            <div class="flex justify-between gap-4">
              <span class="text-neutral-500">写入失败 · 丢弃条目</span>
              <span
                class="font-medium tabular-nums"
                :class="{ 'text-red-600': (info.audit?.dropped_entries ?? 0) > 0 || (info.audit?.write_failures ?? 0) > 0 }"
              >
                {{ info.audit?.write_failures ?? '—' }} / {{ info.audit?.dropped_entries ?? '—' }}（重试 {{ info.audit?.retries ?? '—' }}）
              </span>
            </div>
            <div v-if="info.audit?.last_failure" class="flex justify-between gap-4">
              <span class="text-neutral-500">最近写入失败</span>
              <span class="font-medium" :title="info.audit.last_failure.cause">
                {{ info.audit.last_failure.action || '—' }} · {{ info.audit.last_failure.cause_class || '' }}
              </span>
            </div>
            <div v-if="info.audit?.chain_error" class="text-sm font-medium text-red-600">
              校验自身错误：{{ info.audit.chain_error }}
            </div>
          </div>
        </UCard>
      </div>

      <UCard
        v-if="conc && conc.models.length > 0"
        title="模型并发"
        :description="`采样于 ${(conc.checked_at || '').replace('T', ' ').replace(/Z$/, ' UTC') || '—'} · 峰值每 15s 采样落库，目标为管理员配置的并发参考值`"
      >
        <UTable :data="concRows" :columns="concColumns" class="w-full">
          <template #util-cell="{ row }">
            <span :class="{ 'font-medium text-red-600': row.original.exceeding }">
              {{ row.original.exceeding ? '⚠ ' : '' }}{{ row.original.util }}
            </span>
          </template>
        </UTable>
      </UCard>

      <p class="text-xs text-neutral-400">仅管理员可访问 · 数据实时从服务器获取</p>
    </template>
  </div>
</template>
