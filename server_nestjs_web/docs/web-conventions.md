# 管理端 Web 实现约定（server_nestjs_web）

Nuxt 4.6 + @nuxt/ui v4.12 + @sidebase/nuxt-auth v1.4（local provider，cookie 会话 + CSRF）。

## 目录约定（Nuxt 4 `app/` 结构）
- `app/pages/**`：页面；`app/layouts/default.vue`：已带侧栏的默认布局（自动套用，无需在页面里写布局）。
- `app/composables/useApi.ts`：统一请求助手（**所有页面用它发请求，不要直接 $fetch**）。
- `app/lib/nav.ts`：侧栏 nav + `SessionUser` 类型（不要改 NAV_ENTRIES，除非要增删菜单）。
- 页面级复用组件放 `app/components/`。

## 认证与请求
- 会话来自 `useAuth()`：`const { data, status } = useAuth()`，`data.value` 是 `SessionUser`（字段见 `app/lib/nav.ts`）。
- **发请求**：`const { request } = useApi()`，然后 `request<T>(path, { method, body, query })`。
  - path 是**完整路径**，如 `/api/server/admin/users`（不是相对）。
  - 写方法（POST/PUT/DELETE）自动带 `X-CSRF-Token`（取自 useAuth().token）。
  - 错误已解析为 `ApiError`（`err.message` 即服务端 `error.message`，可直接展示）。
  - 所有数据获取放 `onMounted` / `useAsyncData`（客户端渲染取数），不要 SSR 时取数（cookie 不回传）。
- 表单提交：`await request(...)` 后刷新列表；错误 `catch (e)` 用 `e.message` 展示。
- 响应字段一律 **snake_case**（与服务端契约一致）。

## UI 组件（@nuxt/ui v4）
- 图标用 `i-lucide-*`（如 `i-lucide-users`），通过 `<UIcon :name="..." />` 或组件 `icon` 属性。
- 常用：`UCard` / `UTable`（`data`+`columns`）/ `UButton` / `UInput` / `USelect` / `UForm` / `UFormField`（`label`+`UInput`）/ `UBadge` / `USwitch` / `UCheckbox` / `UModal`（弹窗，v4 无 `UDialog`；受控 `open`+`@update:open`）/ `USkeleton` / `UAlert`（`title`+`description`）/ `UPagination` / `UDropdownMenu` / `UTabs` / `UInputNumber`（`v-model` 必须是 `number | null`）。
- 表格列定义（@nuxt/ui v4 真实 API）：`{ accessorKey: 'username', header: '用户名' }`，自定义单元格用命名插槽 `{accessorKey}-cell`（如 `<template #username-cell="{ row }">`）。**不要用 `{ key, label }`（过时写法，列不渲染）**。
- 文案/标题用中文，与原 webadmin 对齐。

## 页面清单（按分区）
管理：`users`、`departments`、`auth`
运维：`gateway`、`gateway-files`、`error-monitoring`、`usage/*`、`server-info`、`capabilities`、`connectors`
审计：`audit`

## 约束
- 不新增 npm 依赖。
- 不改 `nuxt.config.ts`、`app/layouts/default.vue`、`app/lib/nav.ts`、`app/composables/useApi.ts`、`app/app.vue`。
- 每个页面写完跑 `pnpm exec nuxt typecheck` 确保无类型错误（先 `pnpm exec nuxt prepare` 生成类型）。
- API 端点以 `server_nestjs/docs/contract-0*.md` 为准（那是从现有 Go server 提取的契约）。
