<script setup lang="ts">
import { type SessionUser } from '~/lib/nav'

interface FileRow {
  file_id: string
  user_id: number
  username: string
  display_name: string
  size_bytes: number
  created_at: string
  expires_at: string | null
  expired: boolean
}

interface SummaryRow {
  user_id: number
  username: string
  display_name: string
  files: number
  bytes: number
  expired_files: number
  earliest_expires_at: string | null
}

interface Totals {
  files: number
  bytes: number
  expired: number
}

interface FilesResp {
  rows: FileRow[]
  total: number
  totals: Totals
}

interface SummaryResp {
  rows: SummaryRow[]
  totals: Totals
}

const DEFAULT_SIZE = 20
const PAGE_SIZES = [10, 20, 50, 100]

const { request } = useApi()
const { data: authData } = useAuth()
const user = computed<SessionUser | null>(() => (authData.value as SessionUser | null) ?? null)
const canWrite = computed(() => user.value?.permissions?.includes('gateway:write') ?? false)

const rows = ref<FileRow[]>([])
const summary = ref<SummaryRow[]>([])
const totals = ref<Totals | null>(null)
const total = ref(0)
const page = ref(1)
const size = ref(DEFAULT_SIZE)
const userFilter = ref('')
const userId = ref('')
const q = ref('')
const state = ref<'all' | 'active' | 'expired'>('all')
const sort = ref('created_at')
const order = ref<'asc' | 'desc'>('desc')
const summarySort = ref('bytes')
const loading = ref(true)
const error = ref('')
const okMsg = ref('')
const busy = ref('')
const loadSeq = ref(0)

function fmtBytes(n: unknown): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : -1
  if (v <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  let val = v
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return i > 0 ? `${val.toFixed(1)} ${units[i]}` : `${val} ${units[i]}`
}

function fmtStamp(v: string | null): string | null {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString('zh-CN', { hour12: false })
}

function fmtTime(v: string | null): string {
  return fmtStamp(v) ?? '永久'
}
function fmtDateTime(v: string): string {
  return fmtStamp(v) ?? '—'
}

async function load(p: number) {
  const current = ++loadSeq.value
  loading.value = true
  error.value = ''
  const query: Record<string, unknown> = {
    page: p,
    size: size.value,
    sort: sort.value,
    order: order.value,
  }
  if (userId.value) query.user_id = userId.value
  else if (userFilter.value) query.user = userFilter.value
  if (q.value.trim()) query.q = q.value.trim()
  if (state.value !== 'all') query.state = state.value

  try {
    const [files, sum] = await Promise.all([
      request<FilesResp>('/api/server/admin/gateway/files', { query }),
      request<SummaryResp>('/api/server/admin/gateway/files/summary', {
        query: { sort: summarySort.value, order: 'desc' },
      }),
    ])
    if (current !== loadSeq.value) return
    const lastPage = Math.max(1, Math.ceil(files.total / size.value))
    if (p > lastPage && files.total > 0) {
      page.value = lastPage
      return load(lastPage)
    }
    rows.value = files.rows ?? []
    total.value = files.total ?? 0
    totals.value = files.totals ?? { files: 0, bytes: 0, expired: 0 }
    summary.value = sum.rows ?? []
  }
  catch (e) {
    if (current !== loadSeq.value) return
    rows.value = []
    summary.value = []
    total.value = 0
    error.value = (e as Error).message
  }
  finally {
    if (current === loadSeq.value) loading.value = false
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined
function scheduleLoad() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => load(1), 300)
}

function toggleSort(key: string) {
  if (sort.value === key) order.value = order.value === 'asc' ? 'desc' : 'asc'
  else {
    sort.value = key
    order.value = 'desc'
  }
  page.value = 1
  load(1)
}

function summarySortChanged() {
  load(page.value)
}

async function removeOne(fileID: string) {
  if (!window.confirm(`删除 ${fileID}？会同时删除上游文件与台账记录。`)) return
  busy.value = 'delete'
  okMsg.value = ''
  error.value = ''
  try {
    await request(`/api/server/admin/gateway/files/${encodeURIComponent(fileID)}`, { method: 'DELETE' })
    okMsg.value = `已删除 ${fileID}`
    await load(page.value)
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = ''
  }
}

async function purge() {
  if (busy.value) return
  if (userId.value && !userFilter.value) {
    error.value = '按员工清理请在「员工（用户名）」里填用户名（员工 ID 只用于筛选列表）'
    return
  }
  const name = userFilter.value.trim()
  if (state.value === 'all' && !name) {
    error.value = '批量清理必须指定条件：选择「有效 / 已过期」，或先填「员工（用户名）」（填了员工才可按「全部」状态清理）'
    return
  }
  if (state.value === 'active' && !name) {
    error.value = '清理仍然有效的文件必须指定员工（全组织范围只允许清理已过期文件）'
    return
  }
  const expired = state.value === 'expired'
  const active = state.value === 'active'
  const dangerous = state.value !== 'expired'
  const scope = name ? `员工「${name}」` : '全部员工'
  const what = expired ? '已过期文件' : active ? '仍然有效的文件' : '全部文件（含仍然有效的）'
  const promptText = dangerous
    ? `将对 ${scope} 的${what}执行批量清理，此操作不可撤销。请输入「确认」继续：`
    : `将对 ${scope} 的${what}执行批量清理。请输入「确认」继续：`
  if (window.prompt(promptText) !== '确认') return

  busy.value = 'purge'
  okMsg.value = ''
  error.value = ''
  try {
    const body: Record<string, unknown> = { state: state.value }
    if (name) body.user = name
    const r = await request<{ deleted: number; skipped: number; failed: number; matched: number }>(
      '/api/server/admin/gateway/files/purge',
      { method: 'POST', body },
    )
    let msg = `清理完成：命中 ${r.matched}，删除 ${r.deleted}，失败 ${r.failed}`
    if (r.skipped > 0) msg += `，跳过 ${r.skipped}（正在被回收或已被重新登记，请刷新后重试）`
    okMsg.value = msg
    page.value = 1
    await load(1)
  }
  catch (e) {
    error.value = (e as Error).message
  }
  finally {
    busy.value = ''
  }
}

onMounted(() => load(1))

const fileColumns = [
  { accessorKey: 'file_id', header: '文件 ID' },
  { id: 'employee', header: '员工' },
  { id: 'size', header: '大小' },
  { id: 'created', header: '上传时间' },
  { id: 'expires', header: '过期时间' },
  { id: 'status', header: '状态' },
  { id: 'actions', header: '操作' },
]

const summaryColumns = [
  { id: 'employee', header: '员工' },
  { accessorKey: 'files', header: '文件数' },
  { id: 'bytes', header: '占用' },
  { accessorKey: 'expired_files', header: '已过期' },
  { id: 'earliest', header: '最早过期' },
  { id: 'actions', header: '操作' },
]

const sortLabel: Record<string, string> = {
  created_at: '上传时间',
  expires_at: '过期时间',
  size_bytes: '大小',
  username: '员工',
}
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-6">
    <div>
      <h1 class="text-2xl font-semibold">网关文件</h1>
      <p class="text-sm text-neutral-500">按员工查看上游文件占用（全组织共享配额），可搜索、排序与清理</p>
    </div>

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <UCard>
        <div class="text-sm text-neutral-500">台账文件数</div>
        <div class="text-xl font-semibold tabular-nums">{{ totals ? totals.files.toLocaleString() : '—' }}</div>
      </UCard>
      <UCard>
        <div class="text-sm text-neutral-500">占用字节</div>
        <div class="text-xl font-semibold tabular-nums">{{ totals ? fmtBytes(totals.bytes) : '—' }}</div>
      </UCard>
      <UCard>
        <div class="text-sm text-neutral-500">其中已过期（待回收）</div>
        <div class="text-xl font-semibold tabular-nums">{{ totals ? totals.expired.toLocaleString() : '—' }}</div>
      </UCard>
    </div>

    <UCard title="按员工占用">
      <template #description>
        <div class="flex items-center gap-2">
          <span>排序：</span>
          <USelect
            v-model="summarySort"
            :items="[
              { label: '占用字节', value: 'bytes' },
              { label: '文件数', value: 'files' },
              { label: '用户名', value: 'username' },
            ]"
            class="w-40"
            @update:model-value="summarySortChanged"
          />
        </div>
      </template>
      <UTable :data="summary" :columns="summaryColumns" empty="暂无员工占用记录" class="w-full">
        <template #employee-cell="{ row }">
          <div>
            <div class="font-medium">{{ row.original.display_name || row.original.username }}</div>
            <div class="text-xs text-neutral-400">{{ row.original.username }}</div>
          </div>
        </template>
        <template #bytes-cell="{ row }">
          <span class="tabular-nums">{{ fmtBytes(row.original.bytes) }}</span>
        </template>
        <template #earliest-cell="{ row }">
          <span>{{ fmtTime(row.original.earliest_expires_at) }}</span>
        </template>
        <template #actions-cell="{ row }">
          <UButton
            size="sm"
            variant="ghost"
            label="只看此人"
            @click="userFilter = row.original.username; userId = ''; page = 1; load(1)"
          />
        </template>
      </UTable>
    </UCard>

    <UCard title="文件明细">
      <div class="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <UFormField label="员工（用户名）">
          <UInput v-model="userFilter" placeholder="按用户名筛选" @update:model-value="scheduleLoad" />
        </UFormField>
        <UFormField label="员工 ID">
          <UInput v-model="userId" placeholder="按 ID 筛选" @update:model-value="scheduleLoad" />
        </UFormField>
        <UFormField label="搜索 file_id">
          <UInput v-model="q" placeholder="文件 ID 关键字" @update:model-value="scheduleLoad" />
        </UFormField>
        <UFormField label="状态">
          <USelect
            v-model="state"
            :items="[
              { label: '全部', value: 'all' },
              { label: '有效', value: 'active' },
              { label: '已过期', value: 'expired' },
            ]"
            @update:model-value="page = 1; load(1)"
          />
        </UFormField>
        <UFormField label="每页条数">
          <USelect
            v-model="size"
            :items="PAGE_SIZES.map((n: number) => ({ label: String(n), value: n }))"
            @update:model-value="page = 1; load(1)"
          />
        </UFormField>
        <div class="flex items-end gap-2">
          <UButton icon="i-lucide-refresh-cw" variant="outline" label="刷新" :loading="loading" @click="load(page)" />
          <UButton
            v-if="canWrite"
            icon="i-lucide-eraser"
            color="error"
            variant="soft"
            label="按条件清理"
            :disabled="busy !== ''"
            @click="purge"
          />
        </div>
      </div>

      <UAlert
        v-if="error"
        title="出错了"
        :description="error"
        color="error"
        icon="i-lucide-triangle-alert"
        variant="soft"
        class="mb-4"
      />
      <UAlert
        v-if="okMsg"
        title="成功"
        :description="okMsg"
        color="success"
        icon="i-lucide-circle-check"
        variant="soft"
        class="mb-4"
      />

      <UTable :data="rows" :columns="fileColumns" :loading="loading" empty="没有匹配的文件" class="w-full">
        <template #file_id-cell="{ row }">
          <span class="font-mono text-xs">{{ row.original.file_id }}</span>
        </template>
        <template #employee-cell="{ row }">
          <div>
            <div class="font-medium">{{ row.original.display_name || row.original.username }}</div>
            <div class="text-xs text-neutral-400">{{ row.original.username }}</div>
          </div>
        </template>
        <template #size-cell="{ row }">
          <span class="tabular-nums">{{ fmtBytes(row.original.size_bytes) }}</span>
        </template>
        <template #size-header>
          <button class="flex items-center gap-1" @click="toggleSort('size_bytes')">
            大小{{ sort === 'size_bytes' ? (order === 'asc' ? ' ↑' : ' ↓') : '' }}
          </button>
        </template>
        <template #created-cell="{ row }">
          <span>{{ fmtDateTime(row.original.created_at) }}</span>
        </template>
        <template #created-header>
          <button class="flex items-center gap-1" @click="toggleSort('created_at')">
            上传时间{{ sort === 'created_at' ? (order === 'asc' ? ' ↑' : ' ↓') : '' }}
          </button>
        </template>
        <template #expires-cell="{ row }">
          <span>{{ fmtTime(row.original.expires_at) }}</span>
        </template>
        <template #expires-header>
          <button class="flex items-center gap-1" @click="toggleSort('expires_at')">
            过期时间{{ sort === 'expires_at' ? (order === 'asc' ? ' ↑' : ' ↓') : '' }}
          </button>
        </template>
        <template #status-cell="{ row }">
          <UBadge :color="row.original.expired ? 'error' : 'success'" variant="soft">
            {{ row.original.expired ? '已过期' : '有效' }}
          </UBadge>
        </template>
        <template #actions-cell="{ row }">
          <UButton
            v-if="canWrite"
            size="sm"
            variant="ghost"
            color="error"
            label="删除"
            :disabled="busy !== ''"
            @click="removeOne(row.original.file_id)"
          />
          <span v-else>—</span>
        </template>
      </UTable>

      <div v-if="total > 0" class="mt-4 flex items-center justify-between text-sm">
        <span class="text-neutral-500">共 {{ total }} 条 · 第 {{ page }}/{{ Math.max(1, Math.ceil(total / size)) }} 页</span>
        <div class="flex gap-2">
          <UButton size="sm" variant="outline" label="上一页" :disabled="page <= 1" @click="page--; load(page)" />
          <UButton size="sm" variant="outline" label="下一页" :disabled="page >= Math.ceil(total / size)" @click="page++; load(page)" />
        </div>
      </div>
    </UCard>
  </div>
</template>
