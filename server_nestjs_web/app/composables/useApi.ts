// 管理端 API 请求助手：统一 base 前缀 + CSRF 头 + 错误信封解析。
// 服务端错误信封 = { error: { code, message } }，HTTP 状态码由 ERROR_HTTP_STATUS 决定。

export interface ApiErrorBody {
  error: { code: string; message: string }
}

export class ApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

export function useApi() {
  const { token } = useAuth()
  const runtimeConfig = useRuntimeConfig()
  const baseURL = runtimeConfig.public.apiBase

  function resolveError(e: unknown): ApiError {
    const err = e as { data?: ApiErrorBody; message?: string }
    const body = err?.data
    const code = body?.error?.code ?? 'INTERNAL'
    const message = body?.error?.message ?? err?.message ?? '请求失败'
    return new ApiError(code, message)
  }

  async function request<T = unknown>(
    path: string,
    opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'; body?: unknown; query?: Record<string, unknown> } = {},
  ): Promise<T> {
    const method = opts.method ?? 'GET'
    const headers: Record<string, string> = {}
    if (method !== 'GET' && token.value) {
      headers['X-CSRF-Token'] = token.value
    }
    try {
      return await $fetch<T>(baseURL + path, {
        method,
        headers,
        body: opts.body as undefined,
        query: opts.query as undefined,
        credentials: 'include',
      })
    } catch (e) {
      throw resolveError(e)
    }
  }

  return { request }
}
