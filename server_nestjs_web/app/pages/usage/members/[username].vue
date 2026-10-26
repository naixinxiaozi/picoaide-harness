<script setup lang="ts">
import { fmtMoney, type UsageAggregateResponse } from '~/lib/usage'

const route = useRoute()
const { request } = useApi()

const username = computed(() => String(route.params.username ?? ''))

const loading = ref(true)
const error = ref('')
const modelRows = ref<UsageAggregateResponse['rows']>([])
const dayRows = ref<UsageAggregateResponse['rows']>([])

const modelColumns = [
  { accessorKey: 'label', header: '模型' },
  { accessorKey: 'requests', header: '请求数' },
  { accessorKey: 'prompt_tokens', header: '提示 Token' },
  { accessorKey: 'completion_tokens', header: '补全 Token' },
  { accessorKey: 'cache_tokens', header: '缓存 Token' },
  { accessorKey: 'cost', header: '费用(元)' },
]

const dayColumns = [
  { accessorKey: 'label', header: '日期' },
  { accessorKey: 'requests', header: '请求数' },
  { accessorKey: 'prompt_tokens', header: '提示 Token' },
  { accessorKey: 'completion_tokens', header: '补全 Token' },
  { accessorKey: 'cost', header: '费用(元)' },
]

onMounted(async () => {
  loading.value = true
  error.value = ''
  try {
    const [byModel, byDay] = await Promise.all([
      request<UsageAggregateResponse>('/api/server/admin/usage', {
        query: { group: 'model', username: username.value },
      }),
      request<UsageAggregateResponse>('/api/server/admin/usage', {
        query: { group: 'day', username: username.value },
      }),
    ])
    modelRows.value = byModel.rows
    dayRows.value = byDay.rows
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="space-y-6">
    <UsageTabs />

    <div class="flex items-center justify-between">
      <div>
        <NuxtLink to="/usage/members" class="text-sm text-muted-foreground hover:text-primary">
          <span class="inline-flex items-center gap-1">
            <UIcon name="i-lucide-arrow-left" class="size-4" />
            返回成员列表
          </span>
        </NuxtLink>
        <h1 class="mt-1 text-lg font-semibold">成员用量详情：{{ username }}</h1>
      </div>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-alert-circle"
      title="加载失败"
      :description="error"
    />

    <template v-if="loading">
      <div class="space-y-2">
        <USkeleton v-for="i in 5" :key="i" class="h-9" />
      </div>
    </template>

    <template v-else>
      <UCard title="按模型分布">
        <UTable :data="modelRows" :columns="modelColumns" empty="暂无数据">
          <template #cost-cell="{ row }">
            <span class="tabular-nums">{{ fmtMoney(row.original.cost) }}</span>
          </template>
        </UTable>
      </UCard>

      <UCard title="按日趋势">
        <UTable :data="dayRows" :columns="dayColumns" empty="暂无数据">
          <template #cost-cell="{ row }">
            <span class="tabular-nums">{{ fmtMoney(row.original.cost) }}</span>
          </template>
        </UTable>
      </UCard>
    </template>
  </div>
</template>
