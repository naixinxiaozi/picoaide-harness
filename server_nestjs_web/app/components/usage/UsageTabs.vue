<script setup lang="ts">
// 用量中心共享标签导航：高亮当前路由（成员详情页归属「成员」标签）。
const tabs = [
  { to: '/usage/overview', label: '总览', icon: 'i-lucide-layout-dashboard' },
  { to: '/usage/depts', label: '部门', icon: 'i-lucide-network' },
  { to: '/usage/members', label: '成员', icon: 'i-lucide-users' },
  { to: '/usage/models', label: '模型', icon: 'i-lucide-boxes' },
  { to: '/usage/logs', label: '日志', icon: 'i-lucide-scroll-text' },
  { to: '/usage/balance', label: '余额', icon: 'i-lucide-wallet' },
  { to: '/usage/reports', label: '报表', icon: 'i-lucide-file-bar-chart' },
]
</script>

<template>
  <nav class="flex flex-wrap items-center gap-1 border-b pb-3">
    <NuxtLink
      v-for="tab in tabs"
      :key="tab.to"
      :to="tab.to"
      class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
      active-class="bg-primary/10 text-primary"
    >
      <UIcon :name="tab.icon" class="size-4 shrink-0" />
      <span>{{ tab.label }}</span>
    </NuxtLink>
  </nav>
</template>
