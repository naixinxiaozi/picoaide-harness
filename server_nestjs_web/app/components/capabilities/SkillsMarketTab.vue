<script setup lang="ts">
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'
import { PERM_MARKET_READ, type SessionUser } from '~/lib/nav'

interface MarketSkill {
  id: number
  name: string
  version: string
  description: string
  author: string
  checksum: string
  enabled: boolean
  downloads: number
  calls: number
  official: boolean
  created_at: string
  updated_at: string
}

const { request } = useApi()
const { data } = useAuth()
const toast = useToast()

const user = computed(() => data.value as SessionUser | null)
const canRead = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes(PERM_MARKET_READ) ?? false))
const canWrite = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes('market:write') ?? false))

const skills = ref<MarketSkill[]>([])
const loading = ref(false)

// 新建
const createOpen = ref(false)
const createName = ref('')
const createVersion = ref('')
const createDescription = ref('')
const createAuthor = ref('')
const creating = ref(false)

// 编辑元信息
const editOpen = ref(false)
const editTarget = ref<MarketSkill | null>(null)
const editDescription = ref('')
const editing = ref(false)

// 上传新版
const archiveOpen = ref(false)
const archiveTarget = ref<MarketSkill | null>(null)
const archiveVersion = ref('')
const archiveBase64 = ref('')
const archiveFileName = ref('')
const archiving = ref(false)

// 预览
const previewOpen = ref(false)
const previewTarget = ref<MarketSkill | null>(null)
const previewData = ref<{ files: string[]; skill_md: string; name: string; version: string; checksum: string } | null>(null)
const previewLoading = ref(false)

// 授权
const grantOpen = ref(false)
const grantTarget = ref<MarketSkill | null>(null)

const columns: TableColumn<MarketSkill>[] = [
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'version', header: '版本' },
  { accessorKey: 'author', header: '负责人' },
  { accessorKey: 'description', header: '描述' },
  { id: 'enabled', header: '上架' },
  { id: 'actions', header: '操作' },
]

function errMsg(e: unknown): string {
  return (e as Error)?.message || '请求失败'
}

async function load() {
  loading.value = true
  try {
    const res = await request<{ skills: MarketSkill[] }>('/api/server/admin/skills')
    skills.value = res.skills ?? []
  } catch (e) {
    toast.add({ title: '加载失败', description: errMsg(e), color: 'error' })
  } finally {
    loading.value = false
  }
}

function openCreate() {
  createName.value = ''
  createVersion.value = ''
  createDescription.value = ''
  createAuthor.value = ''
  createOpen.value = true
}

async function submitCreate() {
  if (!createName.value.trim()) {
    toast.add({ title: '名称必填', color: 'error' })
    return
  }
  creating.value = true
  try {
    await request<{ skill: MarketSkill }>('/api/server/admin/skills', {
      method: 'POST',
      body: {
        name: createName.value.trim(),
        version: createVersion.value,
        description: createDescription.value,
        author: createAuthor.value,
      },
    })
    toast.add({ title: '已创建', color: 'success' })
    createOpen.value = false
    load()
  } catch (e) {
    toast.add({ title: '创建失败', description: errMsg(e), color: 'error' })
  } finally {
    creating.value = false
  }
}

function openEdit(s: MarketSkill) {
  editTarget.value = s
  editDescription.value = s.description
  editOpen.value = true
}

async function submitEdit() {
  if (!editTarget.value) return
  editing.value = true
  try {
    await request(`/api/server/admin/skills/${editTarget.value.name}`, {
      method: 'PUT',
      body: {
        name: editTarget.value.name,
        version: editTarget.value.version,
        description: editDescription.value,
        author: editTarget.value.author,
      },
    })
    toast.add({ title: '已保存', color: 'success' })
    editOpen.value = false
    load()
  } catch (e) {
    toast.add({ title: '保存失败', description: errMsg(e), color: 'error' })
  } finally {
    editing.value = false
  }
}

async function toggleEnabled(s: MarketSkill, val: boolean) {
  try {
    if (val) {
      await request(`/api/server/admin/skills/${s.name}/enable`, { method: 'POST' })
    } else {
      await request(`/api/server/admin/skills/${s.name}`, { method: 'DELETE' })
    }
    s.enabled = val
    toast.add({ title: val ? '已上架' : '已下架', color: 'success' })
  } catch (e) {
    toast.add({ title: '切换失败', description: errMsg(e), color: 'error' })
  }
}

function openArchive(s: MarketSkill) {
  archiveTarget.value = s
  archiveVersion.value = ''
  archiveBase64.value = ''
  archiveFileName.value = ''
  archiveOpen.value = true
}

function onArchiveFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (!f) return
  archiveFileName.value = f.name
  const reader = new FileReader()
  reader.onload = () => {
    archiveBase64.value = (reader.result as string).split(',')[1] ?? ''
  }
  reader.readAsDataURL(f)
}

async function submitArchive() {
  if (!archiveTarget.value) return
  if (!archiveVersion.value.trim()) {
    toast.add({ title: '版本必填', color: 'error' })
    return
  }
  if (!archiveBase64.value) {
    toast.add({ title: '请选择归档文件', color: 'error' })
    return
  }
  archiving.value = true
  try {
    await request(`/api/server/admin/skills/${archiveTarget.value.name}/archive`, {
      method: 'POST',
      body: { version: archiveVersion.value.trim(), archive: archiveBase64.value },
    })
    toast.add({ title: '已上传新版', color: 'success' })
    archiveOpen.value = false
    load()
  } catch (e) {
    toast.add({ title: '上传失败', description: errMsg(e), color: 'error' })
  } finally {
    archiving.value = false
  }
}

async function preview(s: MarketSkill) {
  previewTarget.value = s
  previewData.value = null
  previewLoading.value = true
  previewOpen.value = true
  try {
    const res = await request<{ files: string[]; skill_md: string; name: string; version: string; checksum: string }>(
      `/api/server/admin/skills/${s.name}/preview`,
    )
    previewData.value = res
  } catch (e) {
    toast.add({ title: '预览失败', description: errMsg(e), color: 'error' })
  } finally {
    previewLoading.value = false
  }
}

function openGrants(s: MarketSkill) {
  grantTarget.value = s
  grantOpen.value = true
}

function rowMenu(s: MarketSkill): DropdownMenuItem[] {
  return [
    { label: '预览', icon: 'i-lucide-eye', onSelect: () => preview(s) },
    { label: '授权', icon: 'i-lucide-key-round', onSelect: () => openGrants(s) },
    { label: '上传新版', icon: 'i-lucide-upload', onSelect: () => openArchive(s) },
    { label: '编辑', icon: 'i-lucide-pencil', onSelect: () => openEdit(s) },
  ]
}

onMounted(() => {
  if (canRead.value) load()
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <p class="text-sm text-muted-foreground">市场技能的管理与授权。</p>
      <UButton v-if="canWrite" size="sm" icon="i-lucide-plus" label="新建技能" @click="openCreate" />
    </div>

    <UAlert
      v-if="!canRead"
      icon="i-lucide-shield-alert"
      color="warning"
      title="无权限"
      description="你没有读取市场技能的权限。"
    />

    <UTable v-else :columns="columns" :data="skills" :loading="loading" empty="暂无技能">
      <template #name-cell="{ row }">
        <div class="flex items-center gap-2">
          <span class="text-sm">{{ row.original.name }}</span>
          <UBadge v-if="row.original.official" label="官方" color="primary" variant="soft" size="xs" />
        </div>
      </template>
      <template #enabled-cell="{ row }">
        <USwitch
          :model-value="row.original.enabled"
          :disabled="!canWrite"
          @update:model-value="(val: boolean) => toggleEnabled(row.original, val)"
        />
      </template>
      <template #actions-cell="{ row }">
        <UDropdownMenu v-if="canWrite" :items="rowMenu(row.original)">
          <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-more-horizontal" label="操作" />
        </UDropdownMenu>
      </template>
    </UTable>

    <!-- 新建 -->
    <UModal v-model:open="createOpen" title="新建技能">
      <template #body>
        <div class="space-y-4">
          <UFormField label="名称（kebab-case）" required>
            <UInput v-model="createName" placeholder="my-skill" />
          </UFormField>
          <UFormField label="版本">
            <UInput v-model="createVersion" placeholder="1.0.0" />
          </UFormField>
          <UFormField label="负责人">
            <UInput v-model="createAuthor" placeholder="作者" />
          </UFormField>
          <UFormField label="描述">
            <UTextarea v-model="createDescription" placeholder="技能说明" :rows="3" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="取消" @click="createOpen = false" />
          <UButton :loading="creating" label="创建" @click="submitCreate" />
        </div>
      </template>
    </UModal>

    <!-- 编辑 -->
    <UModal v-model:open="editOpen" title="编辑技能">
      <template #body>
        <div class="space-y-4">
          <UFormField label="名称">
            <UInput :model-value="editTarget?.name ?? ''" disabled />
          </UFormField>
          <UFormField label="版本">
            <UInput :model-value="editTarget?.version ?? ''" disabled />
          </UFormField>
          <UFormField label="负责人">
            <UInput :model-value="editTarget?.author ?? ''" disabled />
          </UFormField>
          <UFormField label="描述">
            <UTextarea v-model="editDescription" placeholder="技能说明" :rows="3" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="取消" @click="editOpen = false" />
          <UButton :loading="editing" label="保存" @click="submitEdit" />
        </div>
      </template>
    </UModal>

    <!-- 上传新版 -->
    <UModal v-model:open="archiveOpen" :title="`上传新版 · ${archiveTarget?.name ?? ''}`">
      <template #body>
        <div class="space-y-4">
          <UFormField label="版本" required>
            <UInput v-model="archiveVersion" placeholder="1.1.0" />
          </UFormField>
          <UFormField label="归档文件（zip / tar.gz）" required>
            <div class="space-y-2">
              <input type="file" class="block w-full text-sm" @change="onArchiveFileChange" />
              <p v-if="archiveFileName" class="text-sm text-muted-foreground">已选择：{{ archiveFileName }}</p>
            </div>
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="取消" @click="archiveOpen = false" />
          <UButton :loading="archiving" label="上传" @click="submitArchive" />
        </div>
      </template>
    </UModal>

    <!-- 预览 -->
    <UModal v-model:open="previewOpen" :title="`预览 · ${previewTarget?.name ?? ''}`" scrollable>
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
      :name="grantTarget?.name ?? ''"
      :grants-base="grantTarget ? `/api/server/admin/skills/${grantTarget.name}` : ''"
      @updated="load"
    />
  </div>
</template>
