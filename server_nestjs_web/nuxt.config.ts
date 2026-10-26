export default defineNuxtConfig({
  compatibilityDate: '2026-10-26',
  ssr: false,
  devtools: { enabled: false },
  modules: ['@nuxt/ui', '@sidebase/nuxt-auth'],
  css: ['~/assets/css/main.css'],
  ui: {
    colorMode: true,
    fonts: false
  },
  auth: {
    isEnabled: true,
    baseURL: '',
    provider: {
      type: 'local',
      endpoints: {
        signIn: { path: '/api/server/admin/login', method: 'post' },
        signOut: { path: '/api/server/admin/logout', method: 'post' },
        getSession: { path: '/api/server/admin/me', method: 'get' },
        signUp: false,
      },
      token: {
        signInResponseTokenPointer: '/csrf_token',
        type: '',
        headerName: 'X-CSRF-Token',
        maxAgeInSeconds: 60 * 60 * 12,
      },
      session: {
        dataResponsePointer: '/user',
        dataType: {
          id: 'number',
          username: 'string',
          display_name: 'string',
          email: 'string',
          role: 'string',
          permissions: 'string[]',
          is_admin: 'boolean',
          status: 'number',
        },
      },
      pages: {
        login: '/login',
      },
    },
    globalAppMiddleware: true,
    sessionRefresh: {
      enablePeriodically: false,
      enableOnWindowFocus: false,
    },
  },
  nitro: {
    devProxy: {
      '/api': { target: 'http://127.0.0.1:8787/api', changeOrigin: true },
      '/v1': { target: 'http://127.0.0.1:8787/v1', changeOrigin: true },
    },
  },
  runtimeConfig: {
    public: {
      apiBase: '',
    },
  },
})
