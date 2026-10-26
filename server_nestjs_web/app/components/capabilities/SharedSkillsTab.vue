<script setup lang="ts">
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import { PERM_CAP_READ, type SessionUser } from '~/lib/nav'

interface SharedSkill {
  name: string
  display_name: string
  version: string
  description: string
  author: string
  status: string
  reason: string
  quality: string
  downloads: number
  calls: number
  created_at: string
  updated_at: string
}

const STATUS_ITEMS = [
  { label: '全部', value: '' },
  { label: '待审核', value: 'pending' },
  { label: '已通过', value: 'approved' },
  { label: '已拒绝', value: 'rejected' },
]

const { request } = useApi()
const { data } = useAuth()
const toast = useToast()

const user = computed(() => data.value as SessionUser | null)
const canRead = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes(PERM_CAP_READ) ?? false))
const canWrite = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes('capability:write') ?? false))

const skills = ref<SharedSkill[]>([])
const loading = ref(false)
const statusFilter = ref('')

const rejectOpen = ref(false)
const rejectTarget = ref<SharedSkill | null>(null)
const rejectReason = ref('')
const rejecting = ref(false)

const removeOpen = ref(false)
const removeTarget = ref<SharedSkill | null>(null)
const removing = ref(false)

const previewOpen = ref(false)
const previewTarget = ref<SharedSkill | null>(null)
const previewData = ref<{ files: string[]; skill_md: string } | null>(null)
const previewLoading = ref(false)

const grantOpen = ref(false)
const grantTarget = ref<SharedSkill | null>(null)

const columns: TableColumn<SharedSkill>[] = [
  { accessorKey: 'display_name', header: '名称' },
  { accessorKey: 'version', header: '版本' },
  { accessorKey: 'author', header: '作者' },
  { accessorKey: 'status', header: '状态' },
  { accessorKey: 'quality', header: '精选' },
  { accessorKey: 'downloads', header: '下载' },
  { id: 'actions', header: '操作' },
]

function errMsg(e: unknown): string {
  return (e as Error)?.message || '请求失败'
}

function statusLabel(s: string): string {
  return { pending: '待审核', approved: '已通过', rejected: '已拒绝' }[s] ?? s
}

function statusColor(s: string): string {
  return { pending: 'warning', approved: 'success', rejected: 'error' }[s] ?? 'neutral'
}

async function load() {
  loading.value = true
  try {
    const query: Record<string, unknown> = {}
    if (statusFilter.value) query.status = statusFilter.value
    const res = await request<{ skills: SharedSkill[] }>('/api/server/admin/shared-skills', { query })
    skills.value = res.skills ?? []
  } catch (e) {
    toast.add({ title: '加载失败', description: errMsg(e), color: 'error' })
  } finally {
    loading.value = false
  }
}

async function approve(s: SharedSkill) {
  try {
    await request(`/api/server/admin/shared-skills/${s.name}/${s.version}/approve`, { method: 'POST' })
    toast.add({ title: '已通过', color: 'success' })
    load()
  } catch (e) {
    toast.add({ title: '操作失败', description: errMsg(e), color: 'error' })
  }
}

function openReject(s: SharedSkill) {
  rejectTarget.value = s
  rejectReason.value = ''
  rejectOpen.value = true
}

async function submitReject() {
  if (!rejectTarget.value) return
  if (!rejectReason.value.trim()) {
    toast.add({ title: '请填写拒绝原因', color: 'error' })
    return
  }
  rejecting.value = true
  try {
    await request(`/api/server/admin/shared-skills/${rejectTarget.value.name}/${rejectTarget.value.version}/reject`, {
      method: 'POST',
      body: { reason: rejectReason.value.trim() },
    })
    toast.add({ title: '已拒绝', color: 'success' })
    rejectOpen.value = false
    load()
  } catch (e) {
    toast.add({ title: '操作失败', description: errMsg(e), color: 'error' })
  } finally {
    rejecting.value = false
  }
}

function askRemove(s: SharedSkill) {
  removeTarget.value = s
  removeOpen.value = true
}

async function confirmRemove() {
  if (!removeTarget.value) return
  removing.value = true
  try {
    await request(`/api/server/admin/shared-skills/${removeTarget.value.name}/${removeTarget.value.version}`, {
      method: 'DELETE',
    })
    toast.add({ title: '已删除', color: 'success' })
    removeOpen.value = false
    load()
  } catch (e) {
    toast.add({ title: '删除失败', description: errMsg(e), color: 'error' })
  } finally {
    removing.value = false
  }
}

async function toggleQuality(s: SharedSkill) {
  const next = s.quality === 'featured' ? '' : 'featured'
  try {
    await request(`/api/server/admin/shared-skills/${s.name}/${s.version}/quality`, {
      method: 'PUT',
      body: { quality: next },
    })
    s.quality = next
    toast.add({ title: next === 'featured' ? '已设为精选' : '已取消精选', color: 'success' })
  } catch (e) {
    toast.add({ title: '操作失败', description: errMsg(e), color: 'error' })
  }
}

async function preview(s: SharedSkill) {
  previewTarget.value = s
  previewData.value = null
  previewLoading.value = true
  previewOpen.value = true
  try {
    const res = await request<{ files: string[]; skill_md: string }>(
      `/api/server/admin/shared-skills/${s.name}/${s.version}/preview`,
    )
    previewData.value = res
  } catch (e) {
    toast.add({ title: '预览失败', description: errMsg(e), color: 'error' })
  } finally {
    previewLoading.value = false
  }
}

function openGrants(s: SharedSkill) {
  grantTarget.value = s
  grantOpen.value = true
}

function rowMenu(s: SharedSkill): DropdownMenuItem[] {
  const items: DropdownMenuItem[] = [
    { label: '预览', icon: 'i-lucide-eye', onSelect: () => preview(s) },
    { label: '授权', icon: 'i-lucide-key-round', onSelect: () => openGrants(s) },
    {
      label: s.quality === 'featured' ? '取消精选' : '设为精选',
      icon: 'i-lucide-star',
      onSelect: () => toggleQuality(s),
    },
  ]
  if (s.status === 'pending') {
    items.push({ label: '通过', icon: 'i-lucide-check', color: 'success', onSelect: () => approve(s) })
    items.push({ label: '拒绝', icon: 'i-lucide-x', color: 'error', onSelect: () => openReject(s) })
  }
  items.push({ label: '删除', icon: 'i-lucide-trash-2', color: 'error', onSelect: () => askRemove(s) })
  return items
}

watch(statusFilter, load)

onMounted(() => {
  if (canRead.value) load()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <USelect v-model="statusFilter" :items="STATUS_ITEMS" class="w-40" />
    </div>

    <UAlert
      v-if="!canRead"
      icon="i-lucide-shield-alert"
      color="warning"
      title="无权限"
      description="你没有读取共享技能的权限。"
    />

    <UTable v-else :columns="columns" :data="skills" :loading="loading" empty="暂无共享技能">
      <template #display_name-cell="{ row }">
        <div class="flex flex-col">
          <span class="text-sm">{{ row.original.display_name }}</span>
          <span class="text-xs text-muted-foreground">{{ row.original.name }}</span>
        </div>
      </template>
      <template #status-cell="{ row }">
        <UBadge :label="statusLabel(row.original.status)" :color="statusColor(row.original.status)" variant="soft" size="sm" />
      </template>
      <template #quality-cell="{ row }">
        <UBadge v-if="row.original.quality === 'featured'" label="精选" color="primary" variant="soft" size="sm" />
        <span v-else class="text-muted-foreground">—</span>
      </template>
      <template #actions-cell="{ row }">
        <UDropdownMenu v-if="canWrite" :items="rowMenu(row.original)">
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-more-horizontal" label="操作" />
        </UDropdownMenu>
      </template>
    </UTable>

    <CapabilityLocks />

    <!-- 拒绝原因 -->
    <UModal v-model:open="rejectOpen" :title="`拒绝 · ${rejectTarget?.display_name ?? ''}`">
      <template #body>
        <UFormField label="拒绝原因（≤500 字）" required>
          <UTextarea v-model="rejectReason" placeholder="请填写拒绝原因" :rows="3" />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="取消" @click="rejectOpen = false" />
          <UButton color="error" :loading="rejecting" label="拒绝" @click="submitReject" />
        </div>
      </template>
    </UModal>

    <!-- 删除确认 -->
    <UModal v-model:open="removeOpen" title="删除共享技能">
      <template #body>
        <p class="text-sm">
          确定要删除 <span class="font-semibold">{{ removeTarget?.display_name }}</span> 的版本
          <span class="font-semibold">{{ removeTarget?.version }}</span> 吗？
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="取消" @click="removeOpen = false" />
          <UButton color="error" :loading="removing" label="删除" @click="confirmRemove" />
        </div>
      </template>
    </UModal>

    <!-- 预览 -->
    <UModal v-model:open="previewOpen" :title="`预览 · ${previewTarget?.display_name ?? ''}`" scrollable>
      <template #body>
        <div v-if="previewLoading" class="py-8 text-center text-sm text-muted-foreground">加载中…</div>
        <div v-else-if="previewData" class="space-y-3">
          <div class="flex flex-wrap gap-2 text-sm">
            <UBadge label="文件" color="neutral" variant="soft" size="sm" />
            <span v-for="(f, i) in previewData.files" :key="i" class="rounded bg-muted px-2 py-0.5 font-mono text-xs">{{ f }}</span>
          </div>
          <pre class="whitespace-pre-wrap rounded-md bg-muted p-3 text-xs leading-relaxed">{{ previewData.skill_md }}</pre>
        </div>
      </template>
    </UModal>

    <!-- 授权 -->
    <GrantsModal
      v-model="grantOpen"
      :name="grantTarget?.display_name ?? grantTarget?.name ?? ''"
      :grants-base="grantTarget ? `/api/server/admin/shared-skills/${grantTarget.name}` : ''"
      @updated="load"
    />
  </div>
</template>
