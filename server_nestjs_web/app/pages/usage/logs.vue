<script setup lang="ts">
import { fmtInt, fmtMoney, fmtTime, kindLabel, type UsageRequestRow, type UsageRequestsResponse } from '~/lib/usage'

const { request } = useApi()

const loading = ref(true)
const error = ref('')
const rows = ref<UsageRequestRow[]>([])
const total = ref(0)
const page = ref(1)
const size = ref(20)

const username = ref('')
const model = ref('')
const kind = ref('')
const from = ref('')
const to = ref('')

const sizeOptions = [
  { label: '20 条/页', value: 20 },
  { label: '50 条/页', value: 50 },
  { label: '100 条/页', value: 100 },
]

const kindOptions = [
  { label: '全部', value: '' },
  { label: '对话', value: 'chat' },
  { label: '补全', value: 'completions' },
  { label: '响应', value: 'responses' },
  { label: '嵌入', value: 'embedding' },
  { label: '搜索', value: 'search' },
]

const columns = [
  { accessorKey: 'time', header: '时间' },
  { accessorKey: 'username', header: '成员' },
  { accessorKey: 'model', header: '模型' },
  { accessorKey: 'kind', header: '类型' },
  { accessorKey: 'prompt_tokens', header: '提示 Token' },
  { accessorKey: 'completion_tokens', header: '补全 Token' },
  { accessorKey: 'cache_tokens', header: '缓存 Token' },
  { accessorKey: 'search_requests', header: '搜索次数' },
  { accessorKey: 'cost', header: '费用(元)' },
  { accessorKey: 'estimated', header: '估算' },
]

async function load() {
  loading.value = true
  error.value = ''
  try {
    const query: Record<string, unknown> = { page: page.value, size: size.value }
    if (username.value) query.username = username.value
    if (model.value) query.model = model.value
    if (kind.value) query.kind = kind.value
    if (from.value) query.from = from.value
    if (to.value) query.to = to.value

    const res = await request<UsageRequestsResponse>('/api/server/admin/usage/requests', { query })
    rows.value = res.rows
    total.value = res.total
    page.value = res.page
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function onSearch() {
  page.value = 1
  load()
}

function onPageChange(v: number) {
  page.value = v
  load()
}

function onSizeChange() {
  page.value = 1
  load()
}

onMounted(load)
</script>

<template>
  <div class="space-y-6">
    <UsageTabs />

    <UCard>
      <form class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" @submit.prevent="onSearch">
        <UFormField label="成员">
          <UInput v-model="username" placeholder="用户名" />
        </UFormField>
        <UFormField label="模型">
          <UInput v-model="model" placeholder="模型名" />
        </UFormField>
        <UFormField label="类型">
          <USelect v-model="kind" :items="kindOptions" />
        </UFormField>
        <UFormField label="起始日期">
          <UInput v-model="from" type="date" />
        </UFormField>
        <UFormField label="结束日期">
          <UInput v-model="to" type="date" />
        </UFormField>
        <div class="flex items-end gap-2">
          <UButton type="submit" icon="i-lucide-search" label="查询" :loading="loading" />
          <UButton
            type="button"
            variant="outline"
            color="neutral"
            icon="i-lucide-rotate-ccw"
            label="重置"
            @click="username = ''; model = ''; kind = ''; from = ''; to = ''; onSearch()"
          />
        </div>
      </form>
    </UCard>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-alert-circle"
      title="加载失败"
      :description="error"
    />

    <UCard>
      <template v-if="loading">
        <div class="space-y-2">
          <USkeleton v-for="i in 8" :key="i" class="h-9" />
        </div>
      </template>
      <template v-else>
        <UTable :data="rows" :columns="columns" empty="暂无数据">
          <template #time-cell="{ row }">
            <span class="tabular-nums">{{ fmtTime(row.original.time) }}</span>
          </template>
          <template #kind-cell="{ row }">
            <UBadge :label="kindLabel(row.original.kind)" color="neutral" variant="subtle" />
          </template>
          <template #cost-cell="{ row }">
            <span class="tabular-nums">{{ fmtMoney(row.original.cost) }}</span>
          </template>
          <template #estimated-cell="{ row }">
            <UBadge
              :label="row.original.estimated ? '估算' : '精确'"
              :color="row.original.estimated ? 'warning' : 'success'"
              variant="subtle"
            />
          </template>
        </UTable>

        <div class="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <span>共 {{ fmtInt(total) }} 条</span>
            <USelect v-model="size" :items="sizeOptions" class="w-32" @update:model-value="onSizeChange" />
          </div>
          <UPagination
            :page="page"
            :total="total"
            :items-per-page="size"
            show-controls
            @update:page="onPageChange"
          />
        </div>
      </template>
    </UCard>
  </div>
</template>
