<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { PERM_AUDIT_READ, type SessionUser } from '~/lib/nav'

interface AuditLogEntry {
  id: number
  username: string
  action: string
  detail: string
  prev_hash: string
  hash: string
  created_at: string
  app_id: string
}

const { request } = useApi()
const { data } = useAuth()
const toast = useToast()

const user = computed(() => data.value as SessionUser | null)
const canRead = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes(PERM_AUDIT_READ) ?? false))
const canWrite = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes('audit:retention:write') ?? false))

const logs = ref<AuditLogEntry[]>([])
const total = ref(0)
const page = ref(1)
const size = ref(50)
const loading = ref(false)

const filterUsername = ref('')
const filterAction = ref('')

const retentionDraft = ref<number | null>(null)
const savingRetention = ref(false)

const detailOpen = ref(false)
const detailItem = ref<AuditLogEntry | null>(null)

const columns: TableColumn<AuditLogEntry>[] = [
  { accessorKey: 'created_at', header: '时间' },
  { accessorKey: 'username', header: '用户' },
  { accessorKey: 'action', header: '操作' },
  { accessorKey: 'app_id', header: '应用' },
  { id: 'actions', header: '' },
]

function errMsg(e: unknown): string {
  return (e as Error)?.message || '请求失败'
}

async function loadLogs() {
  loading.value = true
  try {
    const query: Record<string, unknown> = { page: page.value, size: size.value }
    if (filterUsername.value) query.username = filterUsername.value
    if (filterAction.value) query.action = filterAction.value
    const res = await request<{ logs: AuditLogEntry[]; total: number }>('/api/server/admin/audit', { query })
    logs.value = res.logs ?? []
    total.value = res.total ?? 0
  } catch (e) {
    toast.add({ title: '加载失败', description: errMsg(e), color: 'error' })
  } finally {
    loading.value = false
  }
}

async function loadRetention() {
  try {
    const res = await request<{ retention_days: number }>('/api/server/admin/audit/settings')
    retentionDraft.value = res.retention_days
  } catch (e) {
    toast.add({ title: '加载保留天数失败', description: errMsg(e), color: 'error' })
  }
}

async function saveRetention() {
  if (retentionDraft.value == null) return
  savingRetention.value = true
  try {
    await request<{ retention_days: number }>('/api/server/admin/audit/settings', {
      method: 'PUT',
      body: { retention_days: retentionDraft.value },
    })
    toast.add({ title: '保留天数已保存', color: 'success' })
  } catch (e) {
    toast.add({ title: '保存失败', description: errMsg(e), color: 'error' })
  } finally {
    savingRetention.value = false
  }
}

function applyFilter() {
  page.value = 1
  loadLogs()
}

function resetFilter() {
  filterUsername.value = ''
  filterAction.value = ''
  page.value = 1
  loadLogs()
}

function showDetail(row: AuditLogEntry) {
  detailItem.value = row
  detailOpen.value = true
}

function fmtTime(s: string): string {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString()
}

watch(page, () => loadLogs())

onMounted(() => {
  if (canRead.value) {
    loadLogs()
    loadRetention()
  }
})
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold">审计日志</h1>
      <p class="text-sm text-muted-foreground">不可篡改的审计记录链。</p>
    </div>

    <UAlert
      v-if="!canRead"
      icon="i-lucide-shield-alert"
      color="warning"
      title="无权限"
      description="你没有读取审计日志的权限。"
    />

    <template v-else>
      <UCard>
        <template #header>
          <div class="flex flex-wrap items-center gap-2">
            <UInput v-model="filterUsername" placeholder="按用户名筛选" class="w-44" />
            <UInput v-model="filterAction" placeholder="按操作筛选" class="w-44" />
            <UButton color="neutral" variant="outline" icon="i-lucide-search" label="查询" @click="applyFilter" />
            <UButton color="neutral" variant="ghost" icon="i-lucide-rotate-ccw" label="重置" @click="resetFilter" />
          </div>
        </template>

        <UTable :columns="columns" :data="logs" :loading="loading" empty="暂无审计记录">
          <template #created_at-cell="{ row }">
            <span class="text-sm whitespace-nowrap">{{ fmtTime(row.original.created_at) }}</span>
          </template>
          <template #actions-cell="{ row }">
            <UButton
              size="xs"
              variant="ghost"
              color="neutral"
              icon="i-lucide-eye"
              label="详情"
              @click="showDetail(row.original)"
            />
          </template>
        </UTable>

        <div class="mt-4 flex items-center justify-between">
          <span class="text-sm text-muted-foreground">共 {{ total }} 条</span>
          <UPagination v-model:page="page" :total="total" :items-per-page="size" show-edges />
        </div>
      </UCard>

      <UCard v-if="canWrite">
        <template #header>
          <h2 class="text-base font-semibold">保留天数</h2>
        </template>
        <div class="flex flex-wrap items-center gap-3">
          <UInputNumber v-model="retentionDraft" :min="1" :max="3650" class="w-40" />
          <span class="text-sm text-muted-foreground">天（1~3650）</span>
          <UButton :loading="savingRetention" label="保存" @click="saveRetention" />
        </div>
      </UCard>
    </template>

    <UModal v-model:open="detailOpen" title="审计详情">
      <template #body>
        <dl v-if="detailItem" class="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt class="text-muted-foreground">时间</dt>
          <dd>{{ fmtTime(detailItem.created_at) }}</dd>
          <dt class="text-muted-foreground">用户</dt>
          <dd>{{ detailItem.username }}</dd>
          <dt class="text-muted-foreground">操作</dt>
          <dd>{{ detailItem.action }}</dd>
          <dt class="text-muted-foreground">应用</dt>
          <dd>{{ detailItem.app_id }}</dd>
          <dt class="text-muted-foreground">详情</dt>
          <dd class="break-all">{{ detailItem.detail }}</dd>
          <dt class="text-muted-foreground">前序哈希</dt>
          <dd class="break-all font-mono">{{ detailItem.prev_hash }}</dd>
          <dt class="text-muted-foreground">本条哈希</dt>
          <dd class="break-all font-mono">{{ detailItem.hash }}</dd>
        </dl>
      </template>
    </UModal>
  </div>
</template>
