<script setup lang="ts">
import { fmtMoney, type UsageAggregateResponse } from '~/lib/usage'

const { request } = useApi()

const loading = ref(true)
const error = ref('')
const truncated = ref(false)
const rows = ref<UsageAggregateResponse['rows']>([])

const columns = [
  { accessorKey: 'label', header: '部门' },
  { accessorKey: 'requests', header: '请求数' },
  { accessorKey: 'prompt_tokens', header: '提示 Token' },
  { accessorKey: 'completion_tokens', header: '补全 Token' },
  { accessorKey: 'cache_tokens', header: '缓存 Token' },
  { accessorKey: 'embed_requests', header: '嵌入请求' },
  { accessorKey: 'embed_tokens', header: '嵌入 Token' },
  { accessorKey: 'cost', header: '费用(元)' },
]

onMounted(async () => {
  loading.value = true
  error.value = ''
  try {
    const res = await request<UsageAggregateResponse>('/api/server/admin/usage', {
      query: { group: 'dept' },
    })
    rows.value = res.rows
    truncated.value = res.truncated
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

    <UAlert
      v-if="truncated"
      color="warning"
      variant="subtle"
      icon="i-lucide-alert-triangle"
      title="结果过多已截断"
      description="仅展示前 500 行，可前往「日志」按条件过滤。"
    />

    <UCard>
      <template v-if="loading">
        <div class="space-y-2">
          <USkeleton v-for="i in 6" :key="i" class="h-9" />
        </div>
      </template>
      <UTable v-else :data="rows" :columns="columns" empty="暂无数据">
        <template #cost-cell="{ row }">
          <span class="tabular-nums">{{ fmtMoney(row.original.cost) }}</span>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
