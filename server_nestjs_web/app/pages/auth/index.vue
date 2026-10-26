<script setup lang="ts">
import type { SessionUser } from '~/lib/nav'

interface AuthConfig {
  mode: string
  enabled: string
  hide_local: boolean
  min_password_length: number
  ldap: {
    server_url: string
    bind_dn: string
    bind_password: string
    base_dn: string
    user_filter: string
    user_attr: string
    group_filter: string
    group_attr: string
  }
  oidc: {
    issuer: string
    client_id: string
    client_secret: string
    redirect_url: string
  }
  openid: {
    issuer: string
    client_id: string
    client_secret: string
    redirect_url: string
  }
}

interface AuthGetResponse {
  auth: AuthConfig
}

interface TestResult {
  type: string
  ok: boolean
  message: string
  extra?: string
}

const { data } = useAuth()
const session = computed<SessionUser | null>(() => (data.value as SessionUser | null) ?? null)
const canWrite = computed(() => session.value?.is_admin === true || session.value?.permissions?.includes('auth:write') === true)

const { request } = useApi()

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const saveError = ref('')

const methods = reactive({
  local: false,
  ldap: false,
  oidc: false,
  openid: false,
})

const form = reactive({
  hide_local: false,
  min_password_length: null as number | null,
  ldap: {
    server_url: '',
    bind_dn: '',
    bind_password: '',
    base_dn: '',
    user_filter: '',
    user_attr: '',
    group_filter: '',
    group_attr: '',
  },
  oidc: {
    issuer: '',
    client_id: '',
    client_secret: '',
    redirect_url: '',
  },
  openid: {
    issuer: '',
    client_id: '',
    client_secret: '',
    redirect_url: '',
  },
})

function parseEnabled(enabled: string, mode: string): void {
  const parts = (enabled ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length > 0) {
    methods.local = parts.includes('local')
    methods.ldap = parts.includes('ldap')
    methods.oidc = parts.includes('oidc')
    methods.openid = parts.includes('openid')
    return
  }
  // 兼容旧配置：enabled 为空时按 mode 推导
  methods.local = false
  methods.ldap = false
  methods.oidc = false
  methods.openid = false
  switch (mode) {
    case 'ldap':
    case 'both':
      methods.local = true
      methods.ldap = true
      break
    case 'oidc':
      methods.local = true
      methods.oidc = true
      break
    case 'openid':
      methods.local = true
      methods.openid = true
      break
    default:
      methods.local = true
  }
}

async function fetchConfig() {
  loading.value = true
  error.value = ''
  try {
    const res = await request<AuthGetResponse>('/api/server/admin/auth')
    const a = res.auth
    parseEnabled(a.enabled, a.mode)
    form.hide_local = a.hide_local === true
    form.min_password_length = a.min_password_length ?? 10
    form.ldap = { ...a.ldap }
    form.oidc = { ...a.oidc }
    form.openid = { ...a.openid }
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

onMounted(fetchConfig)

function enabledKeys(): string[] {
  const keys: string[] = []
  if (methods.local) keys.push('local')
  if (methods.ldap) keys.push('ldap')
  if (methods.oidc) keys.push('oidc')
  if (methods.openid) keys.push('openid')
  return keys
}

function deriveMode(keys: string[]): string {
  const s = new Set(keys)
  const eq = (...ks: string[]) => ks.every((k) => s.has(k)) && s.size === ks.length
  if (eq('local')) return 'local'
  if (eq('local', 'ldap')) return 'both'
  if (eq('local', 'oidc')) return 'oidc'
  if (eq('local', 'openid')) return 'openid'
  if (eq('ldap')) return 'ldap'
  return ''
}

async function saveConfig() {
  const keys = enabledKeys()
  if (keys.length === 0) {
    saveError.value = '至少启用一种认证方式'
    return
  }
  saving.value = true
  saveError.value = ''
  error.value = ''
  try {
    const body: Record<string, unknown> = {
      enabled: keys.join(','),
      mode: deriveMode(keys),
      hide_local: form.hide_local,
      ldap: { ...form.ldap },
      oidc: { ...form.oidc },
      openid: { ...form.openid },
    }
    if (form.min_password_length !== null) {
      body.min_password_length = form.min_password_length
    }
    await request('/api/server/admin/auth', { method: 'PUT', body })
    await fetchConfig()
  } catch (e) {
    saveError.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

// 测试连接
const testType = ref<'ldap' | 'oidc' | 'openid' | null>(null)
const testPending = ref(false)
const testResult = ref<TestResult | null>(null)

async function runTest(type: 'ldap' | 'oidc' | 'openid') {
  testType.value = type
  testPending.value = true
  testResult.value = null
  try {
    let body: Record<string, unknown>
    if (type === 'ldap') {
      body = { type, ldap: { ...form.ldap } }
    } else if (type === 'oidc') {
      body = { type, oidc: { issuer: form.oidc.issuer } }
    } else {
      body = { type, oidc: { issuer: form.openid.issuer } }
    }
    const res = await request<{ ok: boolean; message: string; users?: number; groups?: number }>(
      '/api/server/admin/auth/test',
      { method: 'POST', body },
    )
    let extra: string | undefined
    if (type === 'ldap' && res.ok) {
      const parts: string[] = []
      if (typeof res.users === 'number') parts.push(`用户 ${res.users}`)
      if (typeof res.groups === 'number') parts.push(`组 ${res.groups}`)
      extra = parts.length > 0 ? `发现 ${parts.join('，')}` : undefined
    }
    testResult.value = { type, ok: res.ok === true, message: res.message, extra }
  } catch (e) {
    testResult.value = { type, ok: false, message: (e as Error).message }
  } finally {
    testPending.value = false
    testType.value = null
  }
}

function testResultLabel(type: string): string {
  if (type === 'ldap') return 'LDAP'
  if (type === 'oidc') return 'OIDC'
  return 'OpenID'
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-semibold">认证配置</h1>
      <UButton
        v-if="canWrite"
        icon="i-lucide-save"
        :loading="saving"
        @click="saveConfig"
      >
        保存
      </UButton>
    </div>

    <UAlert
      v-if="error"
      color="error"
      variant="soft"
      :title="error"
      :close="{ color: 'error', variant: 'link' }"
      @update:open="error = ''"
    />
    <UAlert
      v-if="saveError"
      color="error"
      variant="soft"
      :title="saveError"
      :close="{ color: 'error', variant: 'link' }"
      @update:open="saveError = ''"
    />

    <UAlert v-if="loading" color="neutral" variant="soft" title="加载中…" />

    <template v-else>
      <!-- 认证方式 -->
      <div class="rounded-lg border p-4 space-y-4">
        <h2 class="font-semibold">认证方式</h2>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <USwitch v-model="methods.local" :disabled="!canWrite" label="本地账号" />
          <USwitch v-model="methods.ldap" :disabled="!canWrite" label="LDAP" />
          <USwitch v-model="methods.oidc" :disabled="!canWrite" label="OIDC" />
          <USwitch v-model="methods.openid" :disabled="!canWrite" label="OpenID" />
        </div>
        <div class="space-y-4 border-t pt-4">
          <USwitch
            v-model="form.hide_local"
            :disabled="!canWrite"
            label="隐藏本地登录入口"
            description="开启后员工端登录页不再显示本地账号登录"
          />
          <UFormField label="密码最小长度" description="8~64 位，默认 10">
            <UInputNumber
              v-model="form.min_password_length"
              :min="8"
              :max="64"
              :step="1"
              :disabled="!canWrite"
              class="w-32"
            />
          </UFormField>
        </div>
      </div>

      <!-- LDAP -->
      <div class="rounded-lg border p-4 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="font-semibold">LDAP</h2>
          <UButton
            size="sm"
            variant="outline"
            icon="i-lucide-plug"
            :loading="testPending && testType === 'ldap'"
            @click="runTest('ldap')"
          >
            测试连接
          </UButton>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UFormField label="服务器地址">
            <UInput v-model="form.ldap.server_url" :disabled="!canWrite" placeholder="ldap://127.0.0.1:389" />
          </UFormField>
          <UFormField label="绑定 DN">
            <UInput v-model="form.ldap.bind_dn" :disabled="!canWrite" />
          </UFormField>
          <UFormField label="绑定密码" description="已保存的密钥显示为 ***，保持 *** 即不修改，清空即删除">
            <UInput v-model="form.ldap.bind_password" type="password" :disabled="!canWrite" autocomplete="off" />
          </UFormField>
          <UFormField label="基础 DN">
            <UInput v-model="form.ldap.base_dn" :disabled="!canWrite" />
          </UFormField>
          <UFormField label="用户过滤器">
            <UInput v-model="form.ldap.user_filter" :disabled="!canWrite" />
          </UFormField>
          <UFormField label="用户属性">
            <UInput v-model="form.ldap.user_attr" :disabled="!canWrite" />
          </UFormField>
          <UFormField label="组过滤器">
            <UInput v-model="form.ldap.group_filter" :disabled="!canWrite" />
          </UFormField>
          <UFormField label="组属性">
            <UInput v-model="form.ldap.group_attr" :disabled="!canWrite" />
          </UFormField>
        </div>
      </div>

      <!-- OIDC -->
      <div class="rounded-lg border p-4 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="font-semibold">OIDC</h2>
          <UButton
            size="sm"
            variant="outline"
            icon="i-lucide-plug"
            :loading="testPending && testType === 'oidc'"
            @click="runTest('oidc')"
          >
            测试连接
          </UButton>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UFormField label="Issuer">
            <UInput v-model="form.oidc.issuer" :disabled="!canWrite" placeholder="https://idp.example.com" />
          </UFormField>
          <UFormField label="Client ID">
            <UInput v-model="form.oidc.client_id" :disabled="!canWrite" />
          </UFormField>
          <UFormField label="Client Secret" description="已保存的密钥显示为 ***，保持 *** 即不修改，清空即删除">
            <UInput v-model="form.oidc.client_secret" type="password" :disabled="!canWrite" autocomplete="off" />
          </UFormField>
          <UFormField label="回调地址">
            <UInput v-model="form.oidc.redirect_url" :disabled="!canWrite" />
          </UFormField>
        </div>
      </div>

      <!-- OpenID -->
      <div class="rounded-lg border p-4 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="font-semibold">OpenID</h2>
          <UButton
            size="sm"
            variant="outline"
            icon="i-lucide-plug"
            :loading="testPending && testType === 'openid'"
            @click="runTest('openid')"
          >
            测试连接
          </UButton>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <UFormField label="Issuer">
            <UInput v-model="form.openid.issuer" :disabled="!canWrite" placeholder="https://idp.example.com" />
          </UFormField>
          <UFormField label="Client ID">
            <UInput v-model="form.openid.client_id" :disabled="!canWrite" />
          </UFormField>
          <UFormField label="Client Secret" description="已保存的密钥显示为 ***，保持 *** 即不修改，清空即删除">
            <UInput v-model="form.openid.client_secret" type="password" :disabled="!canWrite" autocomplete="off" />
          </UFormField>
          <UFormField label="回调地址">
            <UInput v-model="form.openid.redirect_url" :disabled="!canWrite" />
          </UFormField>
        </div>
      </div>

      <UAlert
        v-if="testResult"
        :color="testResult.ok ? 'success' : 'error'"
        variant="soft"
        :title="`${testResultLabel(testResult.type)}：${testResult.ok ? '连接成功' : '连接失败'}`"
        :description="[testResult.message, testResult.extra].filter(Boolean).join(' · ')"
        :close="{ color: testResult.ok ? 'success' : 'error', variant: 'link' }"
        @update:open="testResult = null"
      />
    </template>
  </div>
</template>
