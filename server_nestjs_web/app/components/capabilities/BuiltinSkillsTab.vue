<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { PERM_CAP_READ, type SessionUser } from '~/lib/nav'

interface BuiltinSkill {
  name: string
  version: string
  title: string
  description: string
  author: string
  category: string
  sha256: string
  size: number
  files: string[]
  source: string
}

interface BuiltinProblem {
  name: string
  reason: string
}

interface BuiltinResponse {
  dir: string
  dir_exists: boolean
  skills: BuiltinSkill[]
  problems: BuiltinProblem[]
  counts: { skills: number; problems: number }
  load_error?: string
}

const { request } = useApi()
const { data } = useAuth()
const toast = useToast()

const user = computed(() => data.value as SessionUser | null)
const canRead = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes(PERM_CAP_READ) ?? false))

const res = ref<BuiltinResponse | null>(null)
const loading = ref(false)

const columns: TableColumn<BuiltinSkill>[] = [
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'version', header: '版本' },
  { accessorKey: 'title', header: '标题' },
  { accessorKey: 'category', header: '分类' },
  { accessorKey: 'author', header: '作者' },
  { accessorKey: 'size', header: '大小' },
  { accessorKey: 'sha256', header: 'SHA256' },
]

function errMsg(e: unknown): string {
  return (e as Error)?.message || '请求失败'
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

async function load() {
  loading.value = true
  try {
    res.value = await request<BuiltinResponse>('/api/server/admin/skills/builtin')
  } catch (e) {
    toast.add({ title: '加载失败', description: errMsg(e), color: 'error' })
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (canRead.value) load()
})
</script>

<template>
  <div class="space-y-4">
    <UAlert
      v-if="!canRead"
      icon="i-lucide-shield-alert"
      color="warning"
      title="无权限"
      description="你没有读取内置技能的权限。"
    />

    <template v-else>
      <div v-if="res" class="flex flex-wrap items-center gap-2 text-sm">
        <UBadge label="目录" color="neutral" variant="soft" size="sm" />
        <span class="font-mono text-xs">{{ res.dir }}</span>
        <UBadge :label="res.dir_exists ? '存在' : '不存在'" :color="res.dir_exists ? 'success' : 'error'" variant="soft" size="sm" />
        <UBadge label="技能" color="info" variant="soft" size="sm" />
        <span>{{ res.counts?.skills ?? 0 }}</span>
        <UBadge label="问题" color="warning" variant="soft" size="sm" />
        <span>{{ res.counts?.problems ?? 0 }}</span>
      </div>

      <UAlert v-if="res?.load_error" icon="i-lucide-triangle-alert" color="error" title="加载异常" :description="res.load_error" />

      <UCard v-if="res && res.problems.length > 0">
        <template #header>
          <h2 class="text-base font-semibold">加载问题</h2>
        </template>
        <ul class="space-y-1.5 text-sm">
          <li v-for="(p, i) in res.problems" :key="i" class="flex items-start gap-2">
            <span class="font-mono text-xs">{{ p.name }}</span>
            <span class="text-muted-foreground">{{ p.reason }}</span>
          </li>
        </ul>
      </UCard>

      <UTable :columns="columns" :data="res?.skills ?? []" :loading="loading" empty="暂无内置技能">
        <template #size-cell="{ row }">
          <span class="text-sm whitespace-nowrap">{{ fmtSize(row.original.size) }}</span>
        </template>
        <template #sha256-cell="{ row }">
          <span class="font-mono text-xs" :title="row.original.sha256">{{ row.original.sha256.slice(0, 12) }}…</span>
        </template>
      </UTable>
    </template>
  </div>
</template>
