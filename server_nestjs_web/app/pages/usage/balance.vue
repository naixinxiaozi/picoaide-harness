<script setup lang="ts">
import type { SessionUser } from '~/lib/nav'
import {
  balanceModeLabel,
  fmtInt,
  fmtMoney,
  fmtTime,
  type BalanceSummary,
  type GrantRun,
} from '~/lib/usage'

const { request } = useApi()
const { data: sessionData } = useAuth()

const user = computed<SessionUser | null>(() => (sessionData.value as SessionUser | null) ?? null)
const canWrite = computed(() => user.value?.permissions?.includes('user:write') ?? false)

const loading = ref(true)
const error = ref('')
const notice = ref('')
const summary = ref<BalanceSummary | null>(null)
const saving = ref(false)
const granting = ref(false)

const form = reactive({
  enabled: false,
  monthlyAmount: '0',
  monthlyMode: 'add' as 'add' | 'cover',
})

const modeOptions = [
  { label: '累加 (add)', value: 'add' },
  { label: '清零后重发 (cover)', value: 'cover' },
]

const statCards = computed(() => [
  { label: '启用员工数', value: summary.value ? fmtInt(summary.value.users) : '—', icon: 'i-lucide-users' },
  { label: '总余额', value: summary.value ? fmtMoney(summary.value.total_balance) : '—', icon: 'i-lucide-wallet' },
  { label: '透支人数', value: summary.value ? fmtInt(summary.value.overdrawn_users) : '—', icon: 'i-lucide-user-x' },
  { label: '透支欠款', value: summary.value ? fmtMoney(summary.value.overdrawn_debt) : '—', icon: 'i-lucide-trending-down' },
])

async function load() {
  loading.value = true
  error.value = ''
  try {
    summary.value = await request<BalanceSummary>('/api/server/admin/balance')
    form.enabled = summary.value.settings.enabled
    form.monthlyAmount = String(summary.value.settings.monthly_amount)
    form.monthlyMode = (summary.value.settings.monthly_mode === 'cover' ? 'cover' : 'add')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function onSave() {
  const amount = Number(form.monthlyAmount)
  if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000) {
    notice.value = '月度额度必须在 0 ~ 1 亿元之间'
    return
  }
  saving.value = true
  notice.value = ''
  try {
    await request('/api/server/admin/balance', {
      method: 'PUT',
      body: { enabled: form.enabled, monthly_amount: amount, monthly_mode: form.monthlyMode },
    })
    notice.value = '配置已保存'
    await load()
  } catch (e) {
    notice.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

async function onGrant() {
  granting.value = true
  notice.value = ''
  try {
    const res = await request<{ ok: boolean; already: boolean; run: GrantRun }>('/api/server/admin/balance/grant', {
      method: 'POST',
    })
    notice.value = res.already
      ? '本月额度已发放完毕，无新增发放'
      : `已发放 ${res.run.granted} 人，跳过 ${res.run.skipped} 人`
    await load()
  } catch (e) {
    notice.value = (e as Error).message
  } finally {
    granting.value = false
  }
}

onMounted(load)
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
      v-if="notice"
      color="info"
      variant="subtle"
      icon="i-lucide-info"
      title="提示"
      :description="notice"
    />

    <template v-if="loading">
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <USkeleton v-for="i in 4" :key="i" class="h-24" />
      </div>
    </template>

    <template v-else-if="summary">
      <div class="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <UCard v-for="s in statCards" :key="s.label">
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
        <UCard title="发放配置">
          <template v-if="canWrite">
            <UForm class="space-y-4" @submit.prevent="onSave">
              <USwitch
                v-model="form.enabled"
                label="启用余额硬闸门"
                description="关闭后不按余额拦截请求。"
              />
              <UFormField label="月度额度（元）" required>
                <UInput v-model="form.monthlyAmount" type="number" min="0" step="0.01" placeholder="每人每月额度" />
              </UFormField>
              <UFormField label="发放模式" required>
                <USelect v-model="form.monthlyMode" :items="modeOptions" />
              </UFormField>
              <UButton type="submit" icon="i-lucide-save" label="保存配置" :loading="saving" />
            </UForm>
          </template>
          <template v-else>
            <dl class="space-y-2 text-sm">
              <div class="flex justify-between">
                <dt class="text-muted-foreground">余额硬闸门</dt>
                <dd>{{ summary.settings.enabled ? '已启用' : '已停用' }}</dd>
              </div>
              <div class="flex justify-between">
                <dt class="text-muted-foreground">月度额度</dt>
                <dd>{{ fmtMoney(summary.settings.monthly_amount) }}</dd>
              </div>
              <div class="flex justify-between">
                <dt class="text-muted-foreground">发放模式</dt>
                <dd>{{ balanceModeLabel(summary.settings.monthly_mode) }}</dd>
              </div>
            </dl>
          </template>
        </UCard>

        <UCard title="当月发放状态">
          <dl class="space-y-2 text-sm">
            <div class="flex justify-between">
              <dt class="text-muted-foreground">月份</dt>
              <dd>{{ summary.status.month || '—' }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">符合条件</dt>
              <dd>{{ fmtInt(summary.status.eligible) }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">已发放</dt>
              <dd>{{ fmtInt(summary.status.granted) }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">待发放</dt>
              <dd>{{ fmtInt(summary.status.pending) }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted-foreground">已开通账户</dt>
              <dd>{{ fmtInt(summary.status.activated) }}</dd>
            </div>
          </dl>
          <UButton
            v-if="canWrite"
            class="mt-4"
            icon="i-lucide-zap"
            label="立即发放"
            color="primary"
            :loading="granting"
            @click="onGrant"
          />
        </UCard>
      </div>

      <UCard title="发放台账">
        <template v-if="summary.last_grant || summary.month_grant">
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <UCard v-if="summary.month_grant" variant="subtle">
              <template #header>
                <span class="text-sm font-medium">本月批次</span>
              </template>
              <dl class="space-y-1.5 text-sm">
                <div class="flex justify-between"><dt class="text-muted-foreground">月份</dt><dd>{{ summary.month_grant.month }}</dd></div>
                <div class="flex justify-between"><dt class="text-muted-foreground">模式</dt><dd>{{ balanceModeLabel(summary.month_grant.mode) }}</dd></div>
                <div class="flex justify-between"><dt class="text-muted-foreground">金额</dt><dd>{{ fmtMoney(summary.month_grant.amount) }}</dd></div>
                <div class="flex justify-between"><dt class="text-muted-foreground">发放人数</dt><dd>{{ fmtInt(summary.month_grant.affected) }}</dd></div>
                <div class="flex justify-between"><dt class="text-muted-foreground">操作人</dt><dd>{{ summary.month_grant.actor }}</dd></div>
                <div class="flex justify-between"><dt class="text-muted-foreground">时间</dt><dd>{{ fmtTime(summary.month_grant.created_at) }}</dd></div>
              </dl>
            </UCard>
            <UCard v-if="summary.last_grant" variant="subtle">
              <template #header>
                <span class="text-sm font-medium">最近一批</span>
              </template>
              <dl class="space-y-1.5 text-sm">
                <div class="flex justify-between"><dt class="text-muted-foreground">月份</dt><dd>{{ summary.last_grant.month }}</dd></div>
                <div class="flex justify-between"><dt class="text-muted-foreground">模式</dt><dd>{{ balanceModeLabel(summary.last_grant.mode) }}</dd></div>
                <div class="flex justify-between"><dt class="text-muted-foreground">金额</dt><dd>{{ fmtMoney(summary.last_grant.amount) }}</dd></div>
                <div class="flex justify-between"><dt class="text-muted-foreground">发放人数</dt><dd>{{ fmtInt(summary.last_grant.affected) }}</dd></div>
                <div class="flex justify-between"><dt class="text-muted-foreground">操作人</dt><dd>{{ summary.last_grant.actor }}</dd></div>
                <div class="flex justify-between"><dt class="text-muted-foreground">时间</dt><dd>{{ fmtTime(summary.last_grant.created_at) }}</dd></div>
              </dl>
            </UCard>
          </div>
        </template>
        <p v-else class="text-sm text-muted-foreground">暂无发放记录</p>
      </UCard>
    </template>
  </div>
</template>
