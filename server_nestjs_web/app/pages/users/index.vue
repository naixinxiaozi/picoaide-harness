<script setup lang="ts">
import type { SessionUser } from '~/lib/nav'
import { fmtMoney, fmtTokens1, fmtTime } from '~/lib/usage'

interface UserItem {
  id: number
  username: string
  display_name: string
  email: string
  is_admin: boolean
  role: string
  permissions: string[]
  status: number
  balance_money: number
  balance_activated: boolean
  source: string
  password_changeable: boolean
  password_must_change: boolean
  password_changed_at: string
  mfa_enabled: boolean
  groups: string[]
  monthly_usage: number
  monthly_cost: number
}

interface TokenItem {
  id: number
  name: string
  created_at: string
  expires_at: string
  last_used_at: string
  revoked: number
}

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
}

interface UserListResponse {
  users: UserItem[]
  total: number
  page: number
  size: number
}

const { data } = useAuth()
const session = computed<SessionUser | null>(() => (data.value as SessionUser | null) ?? null)
const canWrite = computed(() => session.value?.is_admin === true || session.value?.permissions?.includes('user:write') === true)
const canDeptWrite = computed(() => session.value?.is_admin === true || session.value?.permissions?.includes('dept:write') === true)

const { request } = useApi()

const users = ref<UserItem[]>([])
const total = ref(0)
const page = ref(1)
const size = ref(20)
const q = ref('')
const loading = ref(false)
const error = ref('')

const departments = ref<DepartmentItem[]>([])

const columns = [
  { accessorKey: 'id', header: 'ID' },
  { accessorKey: 'username', header: '用户名' },
  { accessorKey: 'groups', header: '部门' },
  { accessorKey: 'role', header: '角色' },
  { accessorKey: 'status', header: '状态' },
  { accessorKey: 'monthly_usage', header: '本月消费' },
  { accessorKey: 'balance_money', header: '余额' },
  { accessorKey: 'password_changed_at', header: '上次改密' },
  { id: 'actions', header: '操作' },
]

const roleLabels: Record<string, string> = {
  super_admin: '超级管理员',
  auditor: '审计员',
  user: '普通用户',
}

const roleItems = [
  { label: '超级管理员', value: 'super_admin' },
  { label: '审计员', value: 'auditor' },
  { label: '普通用户', value: 'user' },
]

function roleColor(role: string): 'primary' | 'warning' | 'neutral' {
  if (role === 'super_admin') return 'primary'
  if (role === 'auditor') return 'warning'
  return 'neutral'
}

function formatDate(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN')
}

async function fetchUsers() {
  loading.value = true
  error.value = ''
  try {
    const res = await request<UserListResponse>('/api/server/admin/users', {
      query: { page: page.value, size: size.value, q: q.value || undefined },
    })
    users.value = res.users ?? []
    total.value = res.total ?? 0
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

async function fetchDepartments() {
  try {
    const res = await request<{ departments: DepartmentItem[] }>('/api/server/admin/departments')
    departments.value = res.departments ?? []
  } catch {
    // 部门列表加载失败不阻断用户列表主流程
  }
}

onMounted(() => {
  fetchUsers()
  fetchDepartments()
})

function onSearch() {
  page.value = 1
  fetchUsers()
}

function onPageChange(p: number) {
  page.value = p
  fetchUsers()
}

// 新建 / 编辑
const formOpen = ref(false)
const editing = ref<UserItem | null>(null)
const form = reactive({
  username: '',
  password: '',
  display_name: '',
  email: '',
  role: 'user',
  status: 1,
})
const formPending = ref(false)
const formError = ref('')

const formStatusEnabled = computed<boolean>({
  get: () => form.status === 1,
  set: (v: boolean) => {
    form.status = v ? 1 : 0
  },
})

function openCreate() {
  editing.value = null
  Object.assign(form, { username: '', password: '', display_name: '', email: '', role: 'user', status: 1 })
  formError.value = ''
  formOpen.value = true
}

function openEdit(row: UserItem) {
  editing.value = row
  Object.assign(form, {
    username: row.username,
    password: '',
    display_name: row.display_name,
    email: row.email,
    role: row.role,
    status: row.status,
  })
  formError.value = ''
  formOpen.value = true
}

async function submitForm() {
  formPending.value = true
  formError.value = ''
  try {
    if (editing.value) {
      const body: Record<string, unknown> = {
        display_name: form.display_name,
        email: form.email,
        role: form.role,
        status: form.status,
      }
      if (form.password) body.password = form.password
      await request(`/api/server/admin/users/${editing.value.id}`, { method: 'PUT', body })
    } else {
      await request('/api/server/admin/users', {
        method: 'POST',
        body: { username: form.username, password: form.password, role: form.role },
      })
    }
    formOpen.value = false
    await fetchUsers()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    formPending.value = false
  }
}

// 状态开关
const togglingId = ref<number | null>(null)

async function onToggleStatus(row: UserItem, enabled: boolean) {
  togglingId.value = row.id
  error.value = ''
  try {
    await request(`/api/server/admin/users/${row.id}`, {
      method: 'PUT',
      body: { status: enabled ? 1 : 0 },
    })
    row.status = enabled ? 1 : 0
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    togglingId.value = null
  }
}

// 统一确认弹窗（删除 / 重置 MFA 等二次确认动作）
interface ConfirmState {
  open: boolean
  title: string
  message: string
  action: (() => Promise<void>) | null
}
const confirm = reactive<ConfirmState>({ open: false, title: '', message: '', action: null })
const confirmPending = ref(false)
const confirmError = ref('')

function askConfirm(title: string, message: string, action: () => Promise<void>) {
  confirm.title = title
  confirm.message = message
  confirm.action = action
  confirmError.value = ''
  confirm.open = true
}

async function submitConfirm() {
  if (!confirm.action) return
  confirmPending.value = true
  confirmError.value = ''
  try {
    await confirm.action()
    confirm.open = false
  } catch (e) {
    confirmError.value = (e as Error).message
  } finally {
    confirmPending.value = false
  }
}

function openDelete(row: UserItem) {
  askConfirm('删除用户', `确认删除用户「${row.username}」？此操作不可撤销，将一并抹除其令牌、用量与余额流水。`, async () => {
    await request(`/api/server/admin/users/${row.id}`, { method: 'DELETE' })
    await fetchUsers()
  })
}

function onResetMfa(row: UserItem) {
  askConfirm('重置 MFA', `确认重置用户「${row.username}」的 MFA？重置后该用户需重新绑定验证器。`, async () => {
    await request(`/api/server/admin/users/${row.id}/mfa`, { method: 'PUT' })
    row.mfa_enabled = false
  })
}

// 部门分配
const assignOpen = ref(false)
const assigning = ref<UserItem | null>(null)
const assignSelected = ref<number[]>([])
const assignPending = ref(false)
const assignError = ref('')

const departmentItems = computed(() => departments.value.map((d) => ({ label: d.name, value: d.id })))

function openAssign(row: UserItem) {
  assigning.value = row
  assignError.value = ''
  const nameToId = new Map(departments.value.map((d) => [d.name, d.id]))
  assignSelected.value = (row.groups ?? [])
    .map((n) => nameToId.get(n))
    .filter((id): id is number => id !== undefined)
  assignOpen.value = true
}

async function submitAssign() {
  if (!assigning.value) return
  assignPending.value = true
  assignError.value = ''
  try {
    await request(`/api/server/admin/users/${assigning.value.id}/department`, {
      method: 'PUT',
      body: { group_ids: assignSelected.value },
    })
    assignOpen.value = false
    await fetchUsers()
  } catch (e) {
    assignError.value = (e as Error).message
  } finally {
    assignPending.value = false
  }
}

// 查看令牌
const tokensOpen = ref(false)
const tokenUser = ref<UserItem | null>(null)
const tokens = ref<TokenItem[]>([])
const tokensLoading = ref(false)
const tokensError = ref('')

async function openTokens(row: UserItem) {
  tokenUser.value = row
  tokensError.value = ''
  tokens.value = []
  tokensOpen.value = true
  await fetchTokens(row.id)
}

async function fetchTokens(userId: number) {
  tokensLoading.value = true
  tokensError.value = ''
  try {
    const res = await request<{ tokens: TokenItem[] }>(`/api/server/admin/users/${userId}/tokens`, {
      query: { page: 1, size: 50 },
    })
    tokens.value = res.tokens ?? []
  } catch (e) {
    tokensError.value = (e as Error).message
  } finally {
    tokensLoading.value = false
  }
}

async function onRevokeToken(token: TokenItem) {
  if (!tokenUser.value) return
  tokensError.value = ''
  try {
    await request(`/api/server/admin/tokens/${token.id}/revoke`, { method: 'POST' })
    await fetchTokens(tokenUser.value.id)
  } catch (e) {
    tokensError.value = (e as Error).message
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-semibold">用户管理</h1>
      <UButton v-if="canWrite" icon="i-lucide-plus" @click="openCreate">新建用户</UButton>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      :title="error"
      :close="{ color: 'error', variant: 'link' }"
      @update:open="error = ''"
    />

    <div class="flex items-center gap-2">
      <UInput
        v-model="q"
        class="w-72"
        placeholder="搜索用户名 / 显示名 / 邮箱"
        @keyup.enter="onSearch"
      />
      <UButton icon="i-lucide-search" variant="outline" @click="onSearch">搜索</UButton>
    </div>

    <UTable :data="users" :columns="columns" :loading="loading">
      <template #role-cell="{ row }">
        <UBadge :color="roleColor(row.original.role)" variant="soft">
          {{ roleLabels[row.original.role] ?? row.original.role }}
        </UBadge>
      </template>

      <template #status-cell="{ row }">
        <USwitch
          :model-value="row.original.status === 1"
          :disabled="!canWrite || togglingId === row.original.id"
          color="success"
          @update:model-value="(v: boolean) => onToggleStatus(row.original, v)"
        />
      </template>
      <template #monthly_usage-cell="{ row }">
        <span v-if="row.original.is_admin">豁免</span>
        <template v-else>
          <div class="tabular-nums">￥{{ fmtMoney(row.original.monthly_cost) }}</div>
          <div class="tabular-nums">{{ fmtTokens1(row.original.monthly_usage) }} tokens</div>
        </template>
      </template>
      
      <template #balance_money-cell="{ row }">
        <span v-if="row.original.balance_activated" class="tabular-nums">¥{{ Number(row.original.balance_money ?? 0).toFixed(2) }}</span>
        <span v-else>未开通</span>
      </template>

      <template #actions-cell="{ row }">
        <div class="flex items-center gap-1">
          <UButton
            v-if="canWrite"
            icon="i-lucide-pencil"
            variant="ghost"
            color="neutral"
            size="sm"
            square
            :aria-label="`编辑 ${row.original.username}`"
            @click="openEdit(row.original)"
          />
          <UButton
            v-if="canDeptWrite"
            icon="i-lucide-network"
            variant="ghost"
            color="neutral"
            size="sm"
            square
            :aria-label="`分配部门 ${row.original.username}`"
            @click="openAssign(row.original)"
          />
          <UButton
            icon="i-lucide-key-round"
            variant="ghost"
            color="neutral"
            size="sm"
            square
            :aria-label="`查看令牌 ${row.original.username}`"
            @click="openTokens(row.original)"
          />
          <UButton
            v-if="canWrite && row.original.mfa_enabled"
            icon="i-lucide-shield-off"
            variant="ghost"
            color="neutral"
            size="sm"
            square
            :aria-label="`重置 MFA ${row.original.username}`"
            @click="onResetMfa(row.original)"
          />
          <UButton
            v-if="canWrite"
            icon="i-lucide-trash"
            variant="ghost"
            color="error"
            size="sm"
            square
            :aria-label="`删除 ${row.original.username}`"
            @click="openDelete(row.original)"
          />
        </div>
      </template>
    </UTable>

    <div class="flex justify-end">
      <UPagination
        v-model:page="page"
        :total="total"
        :items-per-page="size"
        show-controls
        show-edges
        @update:page="onPageChange"
      />
    </div>

    <!-- 新建 / 编辑用户 -->
    <UModal v-model:open="formOpen" :title="editing ? '编辑用户' : '新建用户'">
      <template #body>
        <UForm :state="form" class="space-y-4" @submit="submitForm">
          <UFormField label="用户名" :required="!editing">
            <UInput v-model="form.username" :disabled="!!editing" autocomplete="off" />
          </UFormField>
          <UFormField label="密码" :required="!editing" :description="editing ? '留空表示不修改' : undefined">
            <UInput v-model="form.password" type="password" autocomplete="new-password" />
          </UFormField>
          <UFormField label="显示名">
            <UInput v-model="form.display_name" />
          </UFormField>
          <UFormField label="邮箱">
            <UInput v-model="form.email" type="email" />
          </UFormField>
          <UFormField label="角色">
            <USelect v-model="form.role" :items="roleItems" />
          </UFormField>
          <UFormField v-if="editing" label="状态">
            <USwitch v-model="formStatusEnabled" label="启用" />
          </UFormField>
          <p v-if="formError" class="text-sm text-error">{{ formError }}</p>
          <div class="flex justify-end gap-2">
            <UButton type="button" variant="outline" @click="formOpen = false">取消</UButton>
            <UButton type="submit" :loading="formPending">保存</UButton>
          </div>
        </UForm>
      </template>
    </UModal>

    <!-- 部门分配 -->
    <UModal v-model:open="assignOpen" :title="`分配部门 - ${assigning?.username ?? ''}`">
      <template #body>
        <div class="space-y-4">
          <!-- <USelect
            v-model="assignSelected"
            :items="departmentItems"
            multiple
            placeholder="选择部门（可多选）"
          /> -->
          <TreeSelect v-model="assignSelected" multiple :options="departmentItems"/>
          <p class="text-xs text-muted-foreground">部门分配为替换式设置，清空选择即移除该用户的全部部门归属。</p>
          <p v-if="assignError" class="text-sm text-error">{{ assignError }}</p>
          <div class="flex justify-end gap-2">
            <UButton type="button" variant="outline" @click="assignOpen = false">取消</UButton>
            <UButton :loading="assignPending" @click="submitAssign">保存</UButton>
          </div>
        </div>
      </template>
    </UModal>

    <!-- 查看令牌 -->
    <UModal v-model:open="tokensOpen" :title="`API 令牌 - ${tokenUser?.username ?? ''}`">
      <template #body>
        <div class="space-y-3">
          <UAlert v-if="tokensError" color="error" variant="soft" :title="tokensError" />
          <p v-if="tokensLoading" class="text-sm text-muted-foreground">加载中…</p>
          <p v-else-if="tokens.length === 0" class="text-sm text-muted-foreground">该用户暂无 API 令牌</p>
          <div v-else class="space-y-2">
            <div
              v-for="t in tokens"
              :key="t.id"
              class="flex items-center justify-between gap-3 rounded-md border p-3"
            >
              <div class="min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-medium">{{ t.name }}</span>
                  <UBadge v-if="t.revoked" color="error" variant="soft" label="已撤销" />
                  <UBadge v-else color="success" variant="soft" label="有效" />
                </div>
                <div class="mt-1 text-xs text-muted-foreground">
                  创建：{{ formatDate(t.created_at) }} · 过期：{{ formatDate(t.expires_at) }} · 最近使用：{{ formatDate(t.last_used_at) }}
                </div>
              </div>
              <UButton
                v-if="!t.revoked && canWrite"
                size="sm"
                variant="outline"
                color="error"
                label="撤销"
                @click="onRevokeToken(t)"
              />
            </div>
          </div>
        </div>
      </template>
    </UModal>

    <!-- 二次确认 -->
    <UModal v-model:open="confirm.open" :title="confirm.title">
      <template #body>
        <div class="space-y-4">
          <p class="text-sm">{{ confirm.message }}</p>
          <p v-if="confirmError" class="text-sm text-error">{{ confirmError }}</p>
          <div class="flex justify-end gap-2">
            <UButton type="button" variant="outline" @click="confirm.open = false">取消</UButton>
            <UButton color="error" :loading="confirmPending" @click="submitConfirm">确认</UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
