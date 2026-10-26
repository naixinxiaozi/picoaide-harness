<template>
  <div class="flex h-screen overflow-hidden">
    <aside class="flex w-60 shrink-0 flex-col border-r bg-muted/20">
      <div class="flex h-14 items-center border-b px-4">
        <span class="text-sm font-semibold">PicoAide 管理台</span>
      </div>
      <nav class="flex-1 space-y-5 overflow-y-auto p-3">
        <div v-for="section in sections" :key="section.name" class="space-y-1">
          <p class="px-2 pb-1 text-xs font-medium text-muted-foreground">{{ section.name }}</p>
          <NuxtLink
            v-for="entry in section.entries"
            :key="entry.to"
            :to="entry.to"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground/80 hover:bg-muted"
            active-class="bg-primary/10 text-primary"
          >
            <UIcon :name="entry.icon" class="size-4 shrink-0" />
            <span class="truncate">{{ entry.label }}</span>
          </NuxtLink>
        </div>
      </nav>
      <div class="flex h-14 items-center justify-between border-t px-4">
        <span class="truncate text-sm">{{ user?.display_name || user?.username }}</span>
        <UButton
          size="sm"
          variant="ghost"
          color="neutral"
          icon="i-lucide-log-out"
          aria-label="退出登录"
          @click="onLogout"
        />
      </div>
    </aside>
    <main class="flex-1 overflow-y-auto p-6">
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
import { visibleNav, type SessionUser } from '~/lib/nav'

const { data, signOut } = useAuth()
const user = computed<SessionUser | null>(() => (data.value as SessionUser | null) ?? null)

const sections = computed(() => {
  const nav = visibleNav(user.value)
  const names = ['管理', '运维', '审计'] as const
  return names
    .map((name) => ({ name, entries: nav.filter((n) => n.section === name) }))
    .filter((s) => s.entries.length > 0)
})

async function onLogout() {
  await signOut({ callbackUrl: '/login', external: false })
}
</script>
