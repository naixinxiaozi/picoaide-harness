<script setup lang="ts">
import type { SessionUser } from '~/lib/nav'

const UButton = resolveComponent('UButton')

interface DepartmentItem {
  id: number
  name: string
  parent_id: number
  leader_id: number
  leader_name?: string
  description: string
  member_count: number
  child_count: number
  granted_count: number
  children?: DepartmentItem[] | null
}

interface UserItem {
  id: number
  username: string
  display_name: string
  email: string
  status: number
}

interface DepartmentListResponse {
  departments: DepartmentItem[]
}

interface UserListResponse {
  users: UserItem[]
  total: number
}

const { data } = useAuth()
const session = computed<SessionUser | null>(() => (data.value as SessionUser | null) ?? null)
const canWrite = computed(() => session.value?.is_admin === true || session.value?.permissions?.includes('dept:write') === true)

const { request } = useApi()

const departments = ref<DepartmentItem[]>([])
const loading = ref(false)
const error = ref('')

// 主管候选：取全部用户列表用于主管下拉
const leaders = ref<UserItem[]>([])
const leadersLoaded = ref(false)

const expanded = ref({ 0: true })

const columns = [
  { accessorKey: 'name', header: '名称', cell: ({ row }) => {
      return h(
        'div',
        {
          style: {
            paddingInlineStart: `${row.depth * 2}rem`
          },
          class: 'flex items-center gap-2'
        },
        [
          h(UButton, {
            color: 'neutral',
            variant: 'outline',
            size: 'xs',
            icon: row.getIsExpanded() ? 'i-lucide-minus' : 'i-lucide-plus',
            class: !row.getCanExpand() && 'invisible',
            ui: {
              base: 'p-0 rounded-sm',
              leadingIcon: 'size-4'
            },
            onClick: row.getToggleExpandedHandler()
          }),
          row.getValue('name') as string
        ]
      )
    }},
  { accessorKey: 'parent', header: '上级部门' },
  { accessorKey: 'leader', header: '主管' },
  { accessorKey: 'member_count', header: '成员数' },
  { accessorKey: 'child_count', header: '下级部门' },
  { id: 'actions', header: '操作' },
]

function parentName(parentId: number): string {
  if (!parentId) return '—'
  return departments.value.find((d) => d.id === parentId)?.name ?? `#${parentId}`
}

async function fetchDepartments() {
  loading.value = true
  error.value = ''
  try {
    const res = await request<DepartmentListResponse>('/api/server/admin/departments')
    departments.value = res.departments ?? []
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function fetchLeaders() {
  if (leadersLoaded.value) return
  try {
    const res = await request<UserListResponse>('/api/server/admin/users', {
      query: { page: 1, size: 200 },
    })
    leaders.value = res.users ?? []
    leadersLoaded.value = true
  } catch {
    // 主管下拉加载失败不阻断部门主流程
  }
}

onMounted(() => {
  fetchDepartments()
  fetchLeaders()
})

// 新建 / 编辑
const formOpen = ref(false)
const editing = ref<DepartmentItem | null>(null)
const form = reactive({
  name: '',
  parent_id: 0,
  leader_id: 0,
  description: '',
})
const formPending = ref(false)
const formError = ref('')

const parentItems = computed(() => [
  { label: '（无，作为顶级部门）', value: 0 },
  ...departments.value
    .filter((d) => !editing.value || d.id !== editing.value.id)
    .map((d) => ({ label: d.name, value: d.id })),
])

const leaderItems = computed(() => [
  { label: '（未指定）', value: 0 },
  ...leaders.value.map((u) => ({ label: u.display_name || u.username, value: u.id })),
])

function openCreate() {
  editing.value = null
  Object.assign(form, { name: '', parent_id: 0, leader_id: 0, description: '' })
  formError.value = ''
  formOpen.value = true
}

function openEdit(row: DepartmentItem) {
  editing.value = row
  Object.assign(form, {
    name: row.name,
    parent_id: row.parent_id,
    leader_id: row.leader_id,
    description: row.description,
  })
  formError.value = ''
  formOpen.value = true
}

async function submitForm() {
  formPending.value = true
  formError.value = ''
  try {
    const body: Record<string, unknown> = {
      name: form.name,
      parent_id: form.parent_id || undefined,
      leader_id: form.leader_id || undefined,
      description: form.description,
    }
    if (editing.value) {
      await request(`/api/server/admin/departments/${editing.value.id}`, { method: 'PUT', body })
    } else {
      await request('/api/server/admin/departments', { method: 'POST', body })
    }
    formOpen.value = false
    await fetchDepartments()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    formPending.value = false
  }
}

// 删除
const confirmOpen = ref(false)
const deleting = ref<DepartmentItem | null>(null)
const deletePending = ref(false)
const deleteError = ref('')

function openDelete(row: DepartmentItem) {
  deleting.value = row
  deleteError.value = ''
  confirmOpen.value = true
}

async function submitDelete() {
  if (!deleting.value) return
  deletePending.value = true
  deleteError.value = ''
  try {
    await request(`/api/server/admin/departments/${deleting.value.id}`, { method: 'DELETE' })
    confirmOpen.value = false
    await fetchDepartments()
  } catch (e) {
    deleteError.value = (e as Error).message
  } finally {
    deletePending.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-semibold">部门管理</h1>
      <UButton v-if="canWrite" icon="i-lucide-plus" @click="openCreate">新建部门</UButton>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      :title="error"
      :close="{ color: 'error', variant: 'link' }"
      @update:open="error = ''"
    />

    <UTable v-model:expanded="expanded" :data="departments" :columns="columns" :loading="loading" :get-sub-rows="(row) => row.children || []" class="flex-1"
      :ui="{
      base: 'border-separate border-spacing-0',
      tbody: '[&>tr]:last:[&>td]:border-b-0',
      tr: 'group',
      td: 'empty:p-0 group-has-[td:not(:empty)]:border-b border-default'
    }">
      <template #parent-cell="{ row }">
        <span class="text-muted-foreground">{{ parentName(row.original.parent_id) }}</span>
      </template>

      <template #leader-cell="{ row }">
        <span class="text-muted-foreground">{{ row.original.leader_name ?? '—' }}</span>
      </template>

      <template #member_count-cell="{ row }">
        <span class="tabular-nums">{{ row.original.member_count }}</span>
      </template>

      <template #actions-cell="{ row }">
        <div v-if="canWrite" class="flex items-center gap-1">
          <UButton
            icon="i-lucide-pencil"
            variant="ghost"
            color="neutral"
            size="sm"
            square
            :aria-label="`编辑 ${row.original.name}`"
            @click="openEdit(row.original)"
          />
          <UButton
            icon="i-lucide-trash"
            variant="ghost"
            color="error"
            size="sm"
            square
            :aria-label="`删除 ${row.original.name}`"
            @click="openDelete(row.original)"
          />
        </div>
      </template>
    </UTable>

    <!-- 新建 / 编辑部门 -->
    <UModal v-model:open="formOpen" :title="editing ? '编辑部门' : '新建部门'">
      <template #body>
        <UForm :state="form" class="space-y-4" @submit="submitForm">
          <UFormField label="名称" required>
            <UInput v-model="form.name" />
          </UFormField>
          <UFormField label="父部门">
            <USelect v-model="form.parent_id" :items="parentItems" />
          </UFormField>
          <UFormField label="主管">
            <USelect v-model="form.leader_id" :items="leaderItems" />
          </UFormField>
          <UFormField label="描述">
            <UTextarea v-model="form.description" :rows="3" />
          </UFormField>
          <p v-if="formError" class="text-sm text-error">{{ formError }}</p>
          <div class="flex justify-end gap-2">
            <UButton type="button" variant="outline" @click="formOpen = false">取消</UButton>
            <UButton type="submit" :loading="formPending">保存</UButton>
          </div>
        </UForm>
      </template>
    </UModal>

    <!-- 删除确认 -->
    <UModal v-model:open="confirmOpen" title="删除部门">
      <template #body>
        <div class="space-y-4">
          <p class="text-sm">
            确认删除部门「{{ deleting?.name }}」？仅当该部门无成员、无子部门且无授权引用时才能删除。
          </p>
          <p v-if="deleteError" class="text-sm text-error">{{ deleteError }}</p>
          <div class="flex justify-end gap-2">
            <UButton type="button" variant="outline" @click="confirmOpen = false">取消</UButton>
            <UButton color="error" :loading="deletePending" @click="submitDelete">确认删除</UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
