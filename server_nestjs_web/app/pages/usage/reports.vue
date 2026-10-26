<script setup lang="ts">
import type { SessionUser } from '~/lib/nav'
import { fmtTime, type ReportSubscription } from '~/lib/usage'

const { request } = useApi()
const { data: sessionData } = useAuth()

const user = computed<SessionUser | null>(() => (sessionData.value as SessionUser | null) ?? null)
const canWrite = computed(() => user.value?.permissions?.includes('report:write') ?? false)

const loading = ref(true)
const error = ref('')
const notice = ref('')
const subscriptions = ref<ReportSubscription[]>([])

const showForm = ref(false)
const editing = ref<ReportSubscription | null>(null)
const saving = ref(false)
const testingId = ref<number | null>(null)
const deletingId = ref<number | null>(null)

const form = reactive({
  name: '',
  hookUrl: '',
  enabled: true,
})

const columns = [
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'enabled', header: '状态' },
  { accessorKey: 'hook_url', header: '回调地址' },
  { accessorKey: 'pending_period', header: '待投递月份' },
  { accessorKey: 'fail_streak', header: '连续失败' },
  { accessorKey: 'last_run_at', header: '上次投递' },
  { accessorKey: 'next_attempt_at', header: '下次尝试' },
  { id: 'actions', header: '操作' },
]

async function load() {
  loading.value = true
  error.value = ''
  try {
    const res = await request<{ subscriptions: ReportSubscription[] }>('/api/server/admin/report-subscriptions')
    subscriptions.value = res.subscriptions
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editing.value = null
  form.name = ''
  form.hookUrl = ''
  form.enabled = true
  showForm.value = true
}

function openEdit(sub: ReportSubscription) {
  editing.value = sub
  form.name = sub.name
  form.hookUrl = ''
  form.enabled = sub.enabled
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  editing.value = null
}

async function onSave() {
  if (!form.name.trim()) {
    notice.value = '订阅名称必填'
    return
  }
  if (!editing.value && !form.hookUrl.trim()) {
    notice.value = '回调地址必填'
    return
  }

  saving.value = true
  notice.value = ''
  try {
    if (editing.value) {
      await request(`/api/server/admin/report-subscriptions/${editing.value.id}`, {
        method: 'PUT',
        body: { name: form.name, hook_url: form.hookUrl, enabled: form.enabled },
      })
      notice.value = '订阅已更新'
    } else {
      await request('/api/server/admin/report-subscriptions', {
        method: 'POST',
        body: { name: form.name, hook_url: form.hookUrl, enabled: form.enabled },
      })
      notice.value = '订阅已创建'
    }
    closeForm()
    await load()
  } catch (e) {
    notice.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

async function onTest(sub: ReportSubscription) {
  testingId.value = sub.id
  notice.value = ''
  try {
    const res = await request<{ ok: boolean; period: string }>(
      `/api/server/admin/report-subscriptions/${sub.id}/test`,
      { method: 'POST' },
    )
    notice.value = `已推送 ${res.period} 月报`
  } catch (e) {
    notice.value = (e as Error).message
  } finally {
    testingId.value = null
  }
}

async function onDelete(sub: ReportSubscription) {
  if (!window.confirm(`确定删除订阅「${sub.name}」？`)) return
  deletingId.value = sub.id
  notice.value = ''
  try {
    await request(`/api/server/admin/report-subscriptions/${sub.id}`, { method: 'DELETE' })
    notice.value = '订阅已删除'
    await load()
  } catch (e) {
    notice.value = (e as Error).message
  } finally {
    deletingId.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-6">
    <UsageTabs />

    <div class="flex items-center justify-between">
      <p class="text-sm text-muted-foreground">配置月报 Webhook 订阅，服务端每小时自动投递上一自然月报表。</p>
      <UButton
        v-if="canWrite"
        icon="i-lucide-plus"
        label="新建订阅"
        @click="openCreate"
      />
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-alert-circle"
      title="加载失败"
      :description="error"
    />

    <UAlert
      v-if="notice"
      color="info"
      variant="subtle"
      icon="i-lucide-info"
      title="提示"
      :description="notice"
    />

    <UCard v-if="showForm" title="订阅信息">
      <UForm class="space-y-4" @submit.prevent="onSave">
        <UFormField label="名称" required>
          <UInput v-model="form.name" placeholder="例如：运营周报机器人" />
        </UFormField>
        <UFormField :label="editing ? '回调地址（留空保持不变）' : '回调地址'" :required="!editing">
          <UInput v-model="form.hookUrl" placeholder="https://example.com/webhook" />
        </UFormField>
        <USwitch v-model="form.enabled" label="启用订阅" />
        <div class="flex items-center gap-2">
          <UButton type="submit" icon="i-lucide-save" label="保存" :loading="saving" />
          <UButton type="button" variant="outline" color="neutral" label="取消" @click="closeForm" />
        </div>
      </UForm>
    </UCard>

    <UCard>
      <template v-if="loading">
        <div class="space-y-2">
          <USkeleton v-for="i in 5" :key="i" class="h-9" />
        </div>
      </template>
      <UTable v-else :data="subscriptions" :columns="columns" empty="暂无订阅">
        <template #enabled-cell="{ row }">
          <UBadge
            :label="row.original.enabled ? '启用' : '停用'"
            :color="row.original.enabled ? 'success' : 'neutral'"
            variant="subtle"
          />
        </template>
        <template #last_run_at-cell="{ row }">
          <span class="tabular-nums">{{ fmtTime(row.original.last_run_at) }}</span>
        </template>
        <template #next_attempt_at-cell="{ row }">
          <span class="tabular-nums">{{ fmtTime(row.original.next_attempt_at) }}</span>
        </template>
        <template #actions-cell="{ row }">
          <div v-if="canWrite" class="flex items-center gap-1">
            <UButton
              size="sm"
              variant="ghost"
              color="neutral"
              icon="i-lucide-send"
              aria-label="测试"
              :loading="testingId === row.original.id"
              @click="onTest(row.original)"
            />
            <UButton
              size="sm"
              variant="ghost"
              color="neutral"
              icon="i-lucide-pencil"
              aria-label="编辑"
              @click="openEdit(row.original)"
            />
            <UButton
              size="sm"
              variant="ghost"
              color="error"
              icon="i-lucide-trash-2"
              aria-label="删除"
              :loading="deletingId === row.original.id"
              @click="onDelete(row.original)"
            />
          </div>
        </template>
      </UTable>
    </UCard>
  </div>
</template>
