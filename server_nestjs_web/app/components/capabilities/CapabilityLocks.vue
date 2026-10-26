<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { SessionUser } from '~/lib/nav'

interface CapabilityLock {
  kind: string
  name: string
  reason: string
  locked_by: string
  created_at: string
}

const { request } = useApi()
const { data } = useAuth()
const toast = useToast()

const user = computed(() => data.value as SessionUser | null)
const canWrite = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes('capability:write') ?? false))

const locks = ref<CapabilityLock[]>([])
const loading = ref(false)

const addOpen = ref(false)
const addKind = ref('skill')
const addName = ref('')
const addReason = ref('')
const adding = ref(false)

const removeOpen = ref(false)
const removeTarget = ref<CapabilityLock | null>(null)
const removing = ref(false)

const columns: TableColumn<CapabilityLock>[] = [
  { accessorKey: 'kind', header: '类型' },
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'reason', header: '原因' },
  { accessorKey: 'locked_by', header: '锁定人' },
  { accessorKey: 'created_at', header: '锁定时间' },
  { id: 'actions', header: '操作' },
]

function errMsg(e: unknown): string {
  return (e as Error)?.message || '请求失败'
}

function kindLabel(k: string): string {
  return k === 'agent' ? 'Agent' : '技能'
}

async function load() {
  loading.value = true
  try {
    const res = await request<{ locks: CapabilityLock[] }>('/api/server/admin/capability-locks')
    locks.value = res.locks ?? []
  } catch (e) {
    toast.add({ title: '加载锁定失败', description: errMsg(e), color: 'error' })
  } finally {
    loading.value = false
  }
}

function openAdd() {
  addKind.value = 'skill'
  addName.value = ''
  addReason.value = ''
  addOpen.value = true
}

async function submitAdd() {
  if (!addName.value.trim()) {
    toast.add({ title: '名称必填', color: 'error' })
    return
  }
  adding.value = true
  try {
    await request(`/api/server/admin/capability-locks/${addKind.value}/${addName.value.trim()}`, {
      method: 'PUT',
      body: { reason: addReason.value },
    })
    toast.add({ title: '已锁定', color: 'success' })
    addOpen.value = false
    load()
  } catch (e) {
    toast.add({ title: '锁定失败', description: errMsg(e), color: 'error' })
  } finally {
    adding.value = false
  }
}

function askRemove(l: CapabilityLock) {
  removeTarget.value = l
  removeOpen.value = true
}

async function confirmRemove() {
  if (!removeTarget.value) return
  removing.value = true
  try {
    await request(`/api/server/admin/capability-locks/${removeTarget.value.kind}/${removeTarget.value.name}`, {
      method: 'DELETE',
    })
    toast.add({ title: '已解锁', color: 'success' })
    removeOpen.value = false
    load()
  } catch (e) {
    toast.add({ title: '解锁失败', description: errMsg(e), color: 'error' })
  } finally {
    removing.value = false
  }
}

onMounted(load)
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-base font-semibold">能力锁定</h2>
          <p class="text-sm text-muted-foreground">锁定后该能力不可再被提交或发布。</p>
        </div>
        <UButton v-if="canWrite" size="sm" icon="i-lucide-lock" label="新增锁定" @click="openAdd" />
      </div>
    </template>

    <UTable :columns="columns" :data="locks" :loading="loading" empty="暂无锁定">
      <template #kind-cell="{ row }">
        <UBadge :label="kindLabel(row.original.kind)" :color="row.original.kind === 'agent' ? 'secondary' : 'info'" variant="soft" size="sm" />
      </template>
      <template #actions-cell="{ row }">
        <UButton
          v-if="canWrite"
          size="xs"
          variant="ghost"
          color="error"
          icon="i-lucide-unlock"
          label="解锁"
          @click="askRemove(row.original)"
        />
      </template>
    </UTable>

    <UModal v-model:open="addOpen" title="新增锁定">
      <template #body>
        <div class="space-y-4">
          <UFormField label="类型" required>
            <USelect
              v-model="addKind"
              :items="[{ label: '技能', value: 'skill' }, { label: 'Agent', value: 'agent' }]"
              class="w-full"
            />
          </UFormField>
          <UFormField label="名称" required>
            <UInput v-model="addName" placeholder="能力名称" />
          </UFormField>
          <UFormField label="原因">
            <UTextarea v-model="addReason" placeholder="锁定原因（≤500 字）" :rows="2" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="取消" @click="addOpen = false" />
          <UButton :loading="adding" label="锁定" @click="submitAdd" />
        </div>
      </template>
    </UModal>

    <UModal v-model:open="removeOpen" title="解除锁定">
      <template #body>
        <p class="text-sm">
          确定要解除对 <span class="font-semibold">{{ removeTarget?.name }}</span> 的锁定吗？
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="取消" @click="removeOpen = false" />
          <UButton color="error" :loading="removing" label="解锁" @click="confirmRemove" />
        </div>
      </template>
    </UModal>
  </UCard>
</template>
