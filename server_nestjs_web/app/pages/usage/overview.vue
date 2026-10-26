<script setup lang="ts">
import { fmtInt, fmtMoney, type UsageOverview } from '~/lib/usage'

const { request } = useApi()

const loading = ref(true)
const error = ref('')
const data = ref<UsageOverview | null>(null)

const trendColumns = [
  { accessorKey: 'label', header: '日期' },
  { accessorKey: 'requests', header: '请求数' },
  { accessorKey: 'prompt_tokens', header: '提示 Token' },
  { accessorKey: 'completion_tokens', header: '补全 Token' },
  { accessorKey: 'cache_tokens', header: '缓存 Token' },
  { accessorKey: 'cost', header: '费用(元)' },
]

const modelColumns = [
  { accessorKey: 'label', header: '模型' },
  { accessorKey: 'requests', header: '请求数' },
  { accessorKey: 'prompt_tokens', header: '提示 Token' },
  { accessorKey: 'completion_tokens', header: '补全 Token' },
  { accessorKey: 'cost', header: '费用(元)' },
]

const stats = computed(() => [
  { label: '本月费用', value: data.value ? fmtMoney(data.value.month.cost) : '—', icon: 'i-lucide-banknote' },
  { label: '本月 Token', value: data.value ? fmtInt(data.value.month.tokens) : '—', icon: 'i-lucide-coins' },
  { label: '本月请求', value: data.value ? fmtInt(data.value.month.requests) : '—', icon: 'i-lucide-activity' },
  { label: '今日费用', value: data.value ? fmtMoney(data.value.today.cost) : '—', icon: 'i-lucide-banknote' },
  { label: '今日 Token', value: data.value ? fmtInt(data.value.today.tokens) : '—', icon: 'i-lucide-coins' },
  { label: '今日请求', value: data.value ? fmtInt(data.value.today.requests) : '—', icon: 'i-lucide-activity' },
])

onMounted(async () => {
  loading.value = true
  error.value = ''
  try {
    data.value = await request<UsageOverview>('/api/server/admin/usage/overview')
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

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-alert-circle"
      title="加载失败"
      :description="error"
    />

    <template v-if="loading">
      <div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <USkeleton v-for="i in 6" :key="i" class="h-24" />
      </div>
    </template>

    <template v-else-if="data">
      <div class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <UCard v-for="s in stats" :key="s.label">
          <div class="flex items-start justify-between">
            <div>
              <p class="text-xs text-muted-foreground">{{ s.label }}</p>
              <p class="mt-2 text-xl font-semibold tabular-nums">{{ s.value }}</p>
            </div>
            <UIcon :name="s.icon" class="size-5 text-muted-foreground" />
          </div>
        </UCard>
      </div>

      <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <UCard title="近 90 天趋势">
          <UTable :data="data.trend" :columns="trendColumns" empty="暂无数据">
            <template #cost-cell="{ row }">
              <span class="tabular-nums">{{ fmtMoney(row.original.cost) }}</span>
            </template>
          </UTable>
        </UCard>

        <UCard title="Top 模型">
          <UTable :data="data.top_models" :columns="modelColumns" empty="暂无数据">
            <template #cost-cell="{ row }">
              <span class="tabular-nums">{{ fmtMoney(row.original.cost) }}</span>
            </template>
          </UTable>
        </UCard>
      </div>
    </template>
  </div>
</template>
