<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import { PERM_CONNECTOR_READ, type SessionUser } from '~/lib/nav'

interface Connector {
  id: string
  name: string
  description: string
  auth_mode: string
  definition: string
  enabled: boolean
  updated_at: string
  created_at: string
}

const AUTH_MODES = [
  { label: 'OAuth 2.0', value: 'oauth' },
  { label: '设备码', value: 'device' },
  { label: '令牌', value: 'token' },
  { label: '服务端', value: 'server-side' },
  { label: '自动', value: 'auto' },
]

const { request } = useApi()
const { data } = useAuth()
const toast = useToast()

const user = computed(() => data.value as SessionUser | null)
const canRead = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes(PERM_CONNECTOR_READ) ?? false))
const canWrite = computed(() => user.value?.role === 'super_admin' || (user.value?.permissions.includes('connector:write') ?? false))

const connectors = ref<Connector[]>([])
const loading = ref(false)

const formOpen = ref(false)
const formMode = ref<'create' | 'edit'>('create')
const formId = ref('')
const formName = ref('')
const formDescription = ref('')
const formAuthMode = ref('oauth')
const formDefinition = ref('')
const formEnabled = ref(true)
const saving = ref(false)

const deleteOpen = ref(false)
const deleteTarget = ref<Connector | null>(null)
const deleting = ref(false)

const columns: TableColumn<Connector>[] = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'name', header: '名称' },
  { accessorKey: 'description', header: '描述' },
  { accessorKey: 'auth_mode', header: '认证方式' },
  { id: 'enabled', header: '启用' },
  { accessorKey: 'updated_at', header: '更新时间' },
  { id: 'actions', header: '操作' },
]

function errMsg(e: unknown): string {
  return (e as Error)?.message || '请求失败'
}

function authModeLabel(v: string): string {
  return AUTH_MODES.find((m) => m.value === v)?.label ?? v
}

function fmtTime(s: string): string {
  if (!s) return '-'
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString()
}

async function load() {
  loading.value = true
  try {
    const res = await request<{ connectors: Connector[] }>('/api/server/admin/connectors')
    connectors.value = res.connectors ?? []
  } catch (e) {
    toast.add({ title: '加载失败', description: errMsg(e), color: 'error' })
  } finally {
    loading.value = false
  }
}

function openCreate() {
  formMode.value = 'create'
  formId.value = ''
  formName.value = ''
  formDescription.value = ''
  formAuthMode.value = 'oauth'
  formDefinition.value = ''
  formEnabled.value = true
  formOpen.value = true
}

function openEdit(c: Connector) {
  formMode.value = 'edit'
  formId.value = c.id
  formName.value = c.name
  formDescription.value = c.description
  formAuthMode.value = c.auth_mode
  formDefinition.value = c.definition
  formEnabled.value = c.enabled
  formOpen.value = true
}

function validateForm(): string | null {
  if (formMode.value === 'create' && !formId.value.trim()) return 'ID 必填'
  if (!formName.value.trim()) return '名称必填'
  const def = formDefinition.value.trim()
  if (!def) return 'definition 必填'
  let parsed: unknown
  try {
    parsed = JSON.parse(def)
  } catch {
    return 'definition 必须是合法 JSON'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'definition 必须是 JSON 对象'
  if (!def.includes('"serverName"') || !def.includes('"mcp"')) {
    return 'definition 需包含 serverName 与 mcp 字段'
  }
  return null
}

async function submitForm() {
  const err = validateForm()
  if (err) {
    toast.add({ title: '校验失败', description: err, color: 'error' })
    return
  }
  saving.value = true
  try {
    if (formMode.value === 'create') {
      await request<{ connector: Connector }>('/api/server/admin/connectors', {
        method: 'POST',
        body: {
          id: formId.value.trim(),
          name: formName.value.trim(),
          description: formDescription.value,
          auth_mode: formAuthMode.value,
          definition: formDefinition.value,
          enabled: formEnabled.value,
        },
      })
      toast.add({ title: '已创建', color: 'success' })
    } else {
      await request<{ connector: Connector }>(`/api/server/admin/connectors/${formId.value}`, {
        method: 'PUT',
        body: {
          name: formName.value.trim(),
          description: formDescription.value,
          auth_mode: formAuthMode.value,
          definition: formDefinition.value,
        },
      })
      toast.add({ title: '已保存', color: 'success' })
    }
    formOpen.value = false
    load()
  } catch (e) {
    toast.add({ title: '保存失败', description: errMsg(e), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(c: Connector, val: boolean) {
  try {
    await request<{ ok: boolean }>(`/api/server/admin/connectors/${c.id}/enabled`, {
      method: 'PUT',
      body: { enabled: val },
    })
    c.enabled = val
    toast.add({ title: val ? '已启用' : '已停用', color: 'success' })
  } catch (e) {
    toast.add({ title: '切换失败', description: errMsg(e), color: 'error' })
  }
}

function askDelete(c: Connector) {
  deleteTarget.value = c
  deleteOpen.value = true
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await request<{ ok: boolean }>(`/api/server/admin/connectors/${deleteTarget.value.id}`, { method: 'DELETE' })
    toast.add({ title: '已删除', color: 'success' })
    deleteOpen.value = false
    load()
  } catch (e) {
    toast.add({ title: '删除失败', description: errMsg(e), color: 'error' })
  } finally {
    deleting.value = false
  }
}

onMounted(() => {
  if (canRead.value) load()
})
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold">连接器</h1>
        <p class="text-sm text-muted-foreground">管理 MCP 连接器的注册与启停。</p>
      </div>
      <UButton v-if="canWrite" icon="i-lucide-plus" label="新建连接器" @click="openCreate" />
    </div>

    <UAlert
      v-if="!canRead"
      icon="i-lucide-shield-alert"
      color="warning"
      title="无权限"
      description="你没有读取连接器的权限。"
    />

    <UCard v-else>
      <UTable :columns="columns" :data="connectors" :loading="loading" empty="暂无连接器">
        <template #auth_mode-cell="{ row }">
          <UBadge :label="authModeLabel(row.original.auth_mode)" color="neutral" variant="soft" size="sm" />
        </template>
        <template #enabled-cell="{ row }">
          <USwitch
            :model-value="row.original.enabled"
            :disabled="!canWrite"
            :loading="false"
            @update:model-value="(val: boolean) => toggleEnabled(row.original, val)"
          />
        </template>
        <template #updated_at-cell="{ row }">
          <span class="text-sm whitespace-nowrap">{{ fmtTime(row.original.updated_at) }}</span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex items-center gap-1">
            <UButton v-if="canWrite" size="xs" variant="ghost" color="neutral" icon="i-lucide-pencil" label="编辑" @click="openEdit(row.original)" />
            <UButton v-if="canWrite" size="xs" variant="ghost" color="error" icon="i-lucide-trash-2" label="删除" @click="askDelete(row.original)" />
          </div>
        </template>
      </UTable>
    </UCard>

    <UModal v-model:open="formOpen" :title="formMode === 'create' ? '新建连接器' : '编辑连接器'">
      <template #body>
        <div class="space-y-4">
          <UFormField label="ID" :required="formMode === 'create'">
            <UInput v-model="formId" placeholder="连接器唯一标识" :disabled="formMode === 'edit'" />
          </UFormField>
          <UFormField label="名称" required>
            <UInput v-model="formName" placeholder="显示名称" />
          </UFormField>
          <UFormField label="描述">
            <UTextarea v-model="formDescription" placeholder="用途说明" :rows="2" />
          </UFormField>
          <UFormField label="认证方式" required>
            <USelect v-model="formAuthMode" :items="AUTH_MODES" class="w-full" />
          </UFormField>
          <UFormField v-if="formMode === 'create'" label="启用">
            <USwitch v-model="formEnabled" label="创建后立即启用" />
          </UFormField>
          <UFormField label="definition（JSON 字符串，含 mcp + serverName）" required>
            <UTextarea v-model="formDefinition" placeholder='{"serverName":"...","mcp":{...}}' :rows="6" class="font-mono" />
          </UFormField>
        </div>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="取消" @click="formOpen = false" />
          <UButton :loading="saving" label="保存" @click="submitForm" />
        </div>
      </template>
    </UModal>

    <UModal v-model:open="deleteOpen" title="删除连接器">
      <template #body>
        <p class="text-sm">
          确定要删除连接器 <span class="font-semibold">{{ deleteTarget?.id }}</span> 吗？此操作不可撤销。
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="取消" @click="deleteOpen = false" />
          <UButton color="error" :loading="deleting" label="删除" @click="confirmDelete" />
        </div>
      </template>
    </UModal>
  </div>
</template>
