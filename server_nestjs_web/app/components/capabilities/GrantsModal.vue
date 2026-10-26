<script setup lang="ts">
const props = defineProps<{
  /** 授权对象名称（用于标题展示）。 */
  name: string
  /** 授权基础路径，例如 `/api/server/admin/skills/foo`。 */
  grantsBase: string
}>()

const open = defineModel<boolean>({ default: false })
const emit = defineEmits<{ updated: [] }>()

interface Grant {
  grantee_type: 'user' | 'group'
  grantee: string
}

const { request } = useApi()
const toast = useToast()

const grants = ref<Grant[]>([])
const loading = ref(false)

const addingType = ref('user')
const addingGrantee = ref('')
const groupsText = ref('')

const TYPE_ITEMS = [
  { label: '用户', value: 'user' },
  { label: '部门', value: 'group' },
]

function errMsg(e: unknown): string {
  return (e as Error)?.message || '请求失败'
}

async function load() {
  loading.value = true
  try {
    const res = await request<{ grants: Grant[] }>(`${props.grantsBase}/grants`)
    grants.value = res.grants ?? []
  } catch (e) {
    toast.add({ title: '加载授权失败', description: errMsg(e), color: 'error' })
  } finally {
    loading.value = false
  }
}

watch(open, (v) => {
  if (v) {
    addingGrantee.value = ''
    groupsText.value = ''
    load()
  }
})

async function addGrant() {
  const grantee = addingGrantee.value.trim()
  if (!grantee) {
    toast.add({ title: '请输入名称', color: 'error' })
    return
  }
  try {
    const body = addingType.value === 'group' ? { group: grantee } : { username: grantee }
    await request(`${props.grantsBase}/grant`, { method: 'PUT', body })
    toast.add({ title: '已授权', color: 'success' })
    addingGrantee.value = ''
    emit('updated')
    load()
  } catch (e) {
    toast.add({ title: '授权失败', description: errMsg(e), color: 'error' })
  }
}

async function removeGrant(g: Grant) {
  try {
    const body = g.grantee_type === 'group' ? { group: g.grantee } : { username: g.grantee }
    await request(`${props.grantsBase}/grant`, { method: 'DELETE', body })
    toast.add({ title: '已撤销', color: 'success' })
    emit('updated')
    load()
  } catch (e) {
    toast.add({ title: '撤销失败', description: errMsg(e), color: 'error' })
  }
}

async function replaceGroups() {
  const groups = groupsText.value
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  try {
    await request(`${props.grantsBase}/grants`, { method: 'PUT', body: { groups } })
    toast.add({ title: '部门授权已更新', color: 'success' })
    groupsText.value = ''
    emit('updated')
    load()
  } catch (e) {
    toast.add({ title: '更新失败', description: errMsg(e), color: 'error' })
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="`授权 · ${name}`">
    <template #body>
      <div class="space-y-4">
        <div class="space-y-2">
          <h3 class="text-sm font-medium">已有授权</h3>
          <div v-if="loading" class="text-sm text-muted-foreground">加载中…</div>
          <div v-else-if="grants.length === 0" class="text-sm text-muted-foreground">暂无授权</div>
          <ul v-else class="space-y-1.5">
            <li
              v-for="(g, i) in grants"
              :key="i"
              class="flex items-center justify-between rounded-md border px-3 py-1.5 text-sm"
            >
              <span class="flex items-center gap-2">
                <UBadge
                  :label="g.grantee_type === 'group' ? '部门' : '用户'"
                  :color="g.grantee_type === 'group' ? 'secondary' : 'info'"
                  variant="soft"
                  size="xs"
                />
                {{ g.grantee }}
              </span>
              <UButton size="xs" variant="ghost" color="error" icon="i-lucide-x" label="撤销" @click="removeGrant(g)" />
            </li>
          </ul>
        </div>

        <USeparator />

        <div class="space-y-2">
          <h3 class="text-sm font-medium">添加授权</h3>
          <div class="flex items-center gap-2">
            <USelect v-model="addingType" :items="TYPE_ITEMS" class="w-28" />
            <UInput v-model="addingGrantee" :placeholder="addingType === 'group' ? '部门名' : '用户名'" class="flex-1" />
            <UButton icon="i-lucide-plus" label="添加" @click="addGrant" />
          </div>
        </div>

        <USeparator />

        <div class="space-y-2">
          <h3 class="text-sm font-medium">批量设置部门授权（整体替换）</h3>
          <UTextarea v-model="groupsText" placeholder="多个部门用逗号或换行分隔" :rows="2" />
          <UButton variant="outline" label="保存部门授权" @click="replaceGroups" />
        </div>
      </div>
    </template>
  </UModal>
</template>
