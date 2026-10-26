<script setup lang="ts">
import { PERM_CAP_READ, PERM_MARKET_READ, type SessionUser } from '~/lib/nav'

interface TabItem {
  label: string
  value: string
  icon: string
}

const { data } = useAuth()

const user = computed(() => data.value as SessionUser | null)
const hasMarket = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes(PERM_MARKET_READ) ?? false))
const hasCap = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes(PERM_CAP_READ) ?? false))

const tabs = computed<TabItem[]>(() => {
  const t: TabItem[] = []
  if (hasMarket.value) t.push({ label: '技能', value: 'skills', icon: 'i-lucide-box' })
  if (hasCap.value) {
    t.push({ label: '共享审核', value: 'shared', icon: 'i-lucide-users' })
    t.push({ label: 'Agent 审核', value: 'agents', icon: 'i-lucide-bot' })
    t.push({ label: '内置技能', value: 'builtin', icon: 'i-lucide-package' })
  }
  return t
})

const active = ref('')

watch(
  tabs,
  (t) => {
    if (!active.value && t.length > 0) active.value = t[0]?.value ?? ''
  },
  { immediate: true },
)
</script>

<template>
  <div class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold">能力中心</h1>
      <p class="text-sm text-muted-foreground">技能、共享审核与 Agent 预设的统一管理。</p>
    </div>

    <UAlert
      v-if="tabs.length === 0"
      icon="i-lucide-shield-alert"
      color="warning"
      title="无权限"
      description="你没有访问能力中心的权限。"
    />

    <UTabs v-else v-model="active" :items="tabs" content>
      <template #content="{ item }">
        <SkillsMarketTab v-if="item.value === 'skills'" />
        <SharedSkillsTab v-else-if="item.value === 'shared'" />
        <AgentPresetsTab v-else-if="item.value === 'agents'" />
        <BuiltinSkillsTab v-else-if="item.value === 'builtin'" />
      </template>
    </UTabs>
  </div>
</template>
