<script setup lang="ts">
// /usage → /usage/overview
onMounted(() => {
  navigateTo('/usage/overview', { replace: true })
})
</script>

<template>
  <div class="flex items-center justify-center py-24 text-muted-foreground">跳转中…</div>
</template>
