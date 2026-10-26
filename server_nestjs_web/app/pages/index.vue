<script setup lang="ts">
import { landingPath, type SessionUser } from '~/lib/nav'

const { data, status } = useAuth()

// 登录后跳转到角色对应的落地页。
watchEffect(() => {
  if (status.value === 'authenticated') {
    const user = data.value as SessionUser | null
    navigateTo(landingPath(user), { replace: true })
  }
})
</script>

<template>
  <div class="flex min-h-screen items-center justify-center text-muted-foreground">
    加载中…
  </div>
</template>
