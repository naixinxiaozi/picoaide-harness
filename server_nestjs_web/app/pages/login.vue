<script setup lang="ts">
const { signIn } = useAuth()
const toast = useToast()
const router = useRouter()

definePageMeta({
  layout: 'auth',
  auth: false
})

useSeoMeta({
  title: 'Login'
})

const loginLoading = ref(false)
const fields = ref([
  {
    name: 'username',
    type: 'text' as const,
    label: '登录账号',
    placeholder: '请输入账号',
    defaultValue: 'admin',
    required: true
  },
  {
    name: 'password',
    type: 'password' as const,
    label: '登录密码',
    placeholder: '请输入密码',
    defaultValue: '6hmRwGGxtDukiZ4RVl3y',
    required: true
  },
  {
    name: 'remember',
    label: '记住登录',
    type: 'checkbox' as const
  }
])

const validate = (state: any) => {
  const errors = []
  if (!state.username) errors.push({ path: 'username', message: '账号不能为空' })
  if (!state.password) errors.push({ path: 'password', message: '密码不能为空' })
  return errors
}

async function onSubmit({ data }) {
  // console.log('onSubmit', data)
  loginLoading.value = true
  signIn(data, { redirect: false })
    .then(() => {
      loginLoading.value = false
      toast.add({ title: '登录成功', duration: 2000, color: 'primary' })
      router.push('/')
    })
    .catch((ex) => {
      loginLoading.value = false
      toast.add({ title: '登录错误', duration: 2000, description: ex.response?.statusText, color: 'error' })
    })
}
</script>

<template>
  <UAuthForm icon="i-lucide-user" :fields="fields" :validate="validate" :validate-on="['blur']" :loading="loginLoading" title="欢迎登录使用" :submit="{ label: '立即登录' }" @submit="onSubmit" />
</template>
