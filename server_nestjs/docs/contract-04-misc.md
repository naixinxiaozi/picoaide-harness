# 渠道内容 + 门户 + 客户端安装包 + bootstrap + 遥测 + 报表订阅 + 审计日志 + 服务器信息 + 后台调度 API 契约

> 提取自 Go 源码（唯一真源：`server/internal/router/router.go` 路由表 + 各业务包非测试 handler）。
> 所有端点返回 JSON。成功用 `c.JSON(...)`；失败统一信封 `{"error":{"code","message"}}`（经 `serverauth.WriteError`）。
> 忽略 `*_test.go`、docker、WASM/apps、MFA。标注「待确认」处为源码未展开/未读到的字段。

## 通用约定

- **命名空间**：客户端面 `/api/client/v2/*`；管理面 `/api/server/admin/*`；另有一条根级下载路由 `/updates/client/*file`（非 `/api`）。
- **鉴权标签**：`public` / `BearerToken`（客户端 bearer，`serverauth.BearerAuth`）/ `AdminSession`（管理会话 + CSRF，`serverauth.AdminAuth`）/ `AdminSession+权限点`（RBAC，`AdminRoute` 申报）。
- **权限点全名**（`server/internal/serverauth/rbac.go`）：`gateway:read`、`gateway:write`、`report:read`、`report:write`、`portal:read`、`portal:write`、`audit:read`、`audit:retention:write`、`server-info:read`。
- **BearerAuth 错误**：无 token → 401 `AUTH_REQUIRED`「缺少认证令牌」；凭证被拒 → 401 `AUTH_FAILED`「令牌无效或已过期」；依赖不可用 → 500 `INTERNAL`「认证服务暂时不可用，请稍后重试」；`PasswordMustChange` 且非白名单 → 403 `PASSWORD_CHANGE_REQUIRED`「请先修改密码」。
- **管理面 RBAC**：未登录 → 401 `AUTH_REQUIRED`「未登录」；权限不足 → 403 `FORBIDDEN`「没有权限执行该操作」。
- **错误信封**：`{"error":{"code":"...","message":"..."}}`。错误码取值：`AUTH_REQUIRED`、`AUTH_FAILED`、`FORBIDDEN`、`NOT_FOUND`、`VALIDATION`、`UPSTREAM`、`RATE_LIMITED`、`INTERNAL`。
- **分页**：管理面统一 `paginate(c, defaultSize, maxSize)`——`page` 缺省 1、非法 `<1` → 1、`>100000` → 100000；`size` 非法或越界 → `defaultSize`。

---

# 1. 渠道内容（channel）

数据源为渠道配置 `channel.json`（镜像内 `/opt/picoaide/channel/`，env `PICOAI_CHANNEL_DIR`，上限 64 KiB）。config 结构（`server/internal/channel/channel.go`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | int | 渠道配置 schema 版本 |
| `channel_id` | string | 渠道标识 |
| `identity.display_name` | string | |
| `identity.short_name` | string | |
| `identity.tagline` | string | |
| `identity.title` | string | |
| `copy.login_display_name` | string | |
| `copy.login_tagline` | string | |
| `copy.login_welcome` | string | |
| `copy.client_display_name` | string | |
| `copy.client_tagline` | string | |
| `copy.portal_welcome` | string | |
| `assets.logo` | string | 浅色 logo 文件名 |
| `assets.logo_dark` | string | 暗色 logo 文件名 |
| `assets.favicon` | string | favicon 文件名 |
| `assets.accent` | string | 主题色 |
| `desktop.deep_link_scheme` | string | |
| `desktop.app_origin_scheme` | string | |
| `desktop.platforms` | []string | 客户端平台，合法集 `{mac,win,linux}`，缺省 `["mac","win","linux"]` |

无配置时 `fallback()` 兜底：`schema=1`、`channel_id="official"`、各展示名 `"Harness"`、`accent="#2563eb"`。

## 1.1 GET /api/client/v2/channel
- 鉴权：public
- 响应头：`Cache-Control: no-cache`
- 成功响应 200（字段全部 omitempty，缺字段 = 客户端不采纳）：
  ```json
  {
    "channel_id": "official",
    "title": "…",
    "login": {
      "display_name": "…",
      "tagline": "…",
      "welcome": "…",
      "logo_url": "/api/client/v2/channel/logo",
      "logo_url_dark": "/api/client/v2/channel/logo-dark"
    },
    "client": {
      "display_name": "…",
      "tagline": "…",
      "logo_url": "/api/client/v2/channel/logo"
    },
    "favicon_url": "/api/client/v2/channel/favicon",
    "accent": "#2563eb"
  }
  ```
- 特殊行为：`logo_url`/`favicon_url` 等素材 URL **只在渠道目录里真有对应文件时**才下发（避免下发会 404 的图片链接）；`logo_url`（浅色）同时填入 `login.logo_url` 与 `client.logo_url`，暗色仅 `login.logo_url_dark`。

## 1.2 GET/HEAD /api/client/v2/channel/logo
- 鉴权：public
- 响应头（成功）：`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`、`Cache-Control: no-cache`，经 `http.ServeContent`（支持 Range/条件请求）。
- 未配置 → 404：`{"error":{"code":"NOT_FOUND","message":"渠道未配置 logo"}}`
- 特殊行为（SVG 守卫，`.svg` 扩展名）：内容经 `decodeNumericCharRefs` 后匹配 8 条脚本特征正则（`<script`/事件处理属性/`javascript:` URL/`<foreignObject>`/`<use>` 外链/`<iframe>`/`<embed>`/`<animate>` 的 href），命中即拒发（404 同信封）。仅检查前 1 MiB，超限不检查照常下发（由 CSP `sandbox` 无 `allow-scripts` 兜底）。素材必须是渠道目录内普通文件（`Lstat` 不跟随符号链接，非普通文件按「未配置」404）。

## 1.3 GET/HEAD /api/client/v2/channel/logo-dark
- 鉴权：public
- 同 1.2；未配置 → 404 `{"error":{"code":"NOT_FOUND","message":"渠道未配置暗色 logo"}}`

## 1.4 GET/HEAD /api/client/v2/channel/favicon
- 鉴权：public
- 同 1.2；未配置 → 404 `{"error":{"code":"NOT_FOUND","message":"渠道未配置 favicon"}}`

## 1.5 GET /api/server/admin/channels
- 鉴权：AdminSession + `gateway:read`
- 说明：这是 **LLM 网关上游渠道列表**（provider channels，`channels.All()` 注册表），**不是**客户渠道内容。
- 成功响应 200：
  ```json
  { "channels": [ { "name": "…", "base_url": "…" } ] }
  ```

---

# 2. 门户（portal）

门户配置存于 settings 键 `portal.*`（`portal.enabled` / `portal.public` / `portal.subtitle` / `portal.client_download_url` / `portal.client_download_linux` / `portal.client_download_mac` / `portal.client_download_win` / `portal.client_download_note` / `portal.landing_path`）。

## 2.1 GET /api/server/admin/portal
- 鉴权：AdminSession + `portal:read`
- 成功响应 200（`ConfigResponse` = 内嵌 `Config` 在顶层 + 保留字段声明）：
  ```json
  {
    "enabled": true,
    "public": true,
    "subtitle": "…",
    "client_download_url": "…",
    "client_download_linux": "…",
    "client_download_mac": "…",
    "client_download_win": "…",
    "client_download_note": "…",
    "landing_path": "…",
    "reserved_fields": ["enabled", "landing_path"],
    "reserved_note": "enabled 与 landing_path 是保留字段(尚未生效):接口照常接受并原样回显,但当前没有任何消费方。要让门户下线请设 public=false;登录后落地页由角色默认分区决定。"
  }
  ```
- 特殊行为：`client_download_url` 为 omitempty；`enabled` 缺省 `true`、`public` 缺省 `true`（键值非 `"false"` 即视为 true）。

## 2.2 PUT /api/server/admin/portal
- 鉴权：AdminSession + `portal:write`
- 请求体（**全指针**，`null`/缺省 = 保持现值，部分更新）：
  ```json
  {
    "enabled": true, "public": true, "subtitle": "…",
    "client_download_url": "…", "client_download_linux": "…",
    "client_download_mac": "…", "client_download_win": "…",
    "client_download_note": "…", "landing_path": "…"
  }
  ```
- 错误：
  - 请求体格式错 → 400 `VALIDATION`「门户配置格式不正确」
  - 保存失败 → 500 `INTERNAL`「门户配置保存失败」
- 成功响应 200：同 2.1（保存后重读回显）。

---

# 3. 客户端安装包（client-release）

安装包目录 `/opt/picoaide/client`（env `PICOAI_CLIENT_RELEASE_DIR` 覆盖），描述文件 `CLIENT-RELEASE.json`：`{schema(int), channel_id(string), client{version(string), assets(map[string]{file,sha256,size})}}`。

## 3.1 GET /api/client/v2/updates/manifest
- 鉴权：public
- 响应头：`Cache-Control: no-store`
- 成功响应 200：
  ```json
  {
    "schema": 1,
    "channel_id": "official",
    "server": { "version": "<serverVersion>" },
    "client": {
      "version": "…",
      "assets": {
        "mac": { "url": "<origin>/updates/client/<file>", "sha256": "…", "size": 123 },
        "win": { "url": "<origin>/updates/client/<file>", "sha256": "…", "size": 123 },
        "linux": { "url": "<origin>/updates/client/<file>", "sha256": "…", "size": 123 }
      }
    },
    "client_unavailable": "server origin is not https; set PICOAI_PUBLIC_BASE_URL"
  }
  ```
- 特殊行为：
  - `client` 段仅在 `CLIENT-RELEASE.json` 存在时出现；`client_unavailable` 仅在 origin 不可用时出现（两者互斥）。
  - origin 判定优先级：env `PICOAI_PUBLIC_BASE_URL` → settings `server.base_url` → 请求为 `X-Forwarded-Proto: https` 或 TLS → 回环 Host（http）→ 不可用（`client_unavailable` = reason）。`normalizeBaseURL` 拒绝含 userinfo/query/fragment/非 http(s) 的 base URL；`https` 恒安全，`http` 仅回环安全。
  - `server.version` 是客户端版本检查的唯一信号（bootstrap 的 `server_version` 字段仅诊断、无消费方）。

## 3.2 GET/HEAD /updates/client/*file
- 鉴权：public（根级路由，非 `/api` 命名空间）
- 响应头（成功）：`X-Content-Type-Options: nosniff`、`Cache-Control: public, max-age=31536000, immutable`、`Content-Type`（按扩展名）、`Content-Disposition: attachment; filename="…"`（非 ASCII 文件名追加 `; filename*=UTF-8''…`），经 `http.ServeContent`（同一 fd，支持 Range/条件请求）。
- 不存在/非法 → 404：`{"error":{"code":"NOT_FOUND","message":"客户端安装包不存在"}}`
- 特殊行为：
  - 文件名必须单段、非空、不含 `..`；允许扩展名 `.dmg` / `.exe` / `.appimage` / `.deb` / `.zip` / `.tar.gz` / `.msi` / `.pkg`。
  - Content-Type 映射 8 种（如 `.exe` → `application/vnd.microsoft.portable-executable`、`.dmg` → `application/x-apple-diskimage`、`.appimage` → `application/vnd.appimage`、`.msi` → `application/x-msi` 等），未知回落 `application/octet-stream`。
  - 下载写超时 = `max(5min, size / 64KiB/s)`，上限 1h（防止慢客户端无限占用连接）。

---

# 4. bootstrap

## 4.1 GET /api/client/v2/config/bootstrap
- 鉴权：BearerToken
- 错误：
  - 未认证 → 401 `AUTH_REQUIRED`「未认证」
  - 生成失败 → 500 `INTERNAL`「启动配置生成失败」
- 成功响应 200（字段名固定，客户端 `BootstrapConfig` 逐字对齐）：
  ```json
  {
    "default_model": "…",
    "models": [
      { "id": "…", "display_name": "…", "default_params": "…", "input_modalities": ["text", "…"] }
    ],
    "skills": [
      { "name": "…", "version": "…", "description": "…" }
    ],
    "web": {
      "error_reporting_dsn": "…",
      "error_reporting_enabled": false,
      "error_reporting_level": "error",
      "error_reporting_heartbeat": false,
      "glitchtip_base_url": "…",
      "glitchtip_organization": "…",
      "default_thinking_level": "max"
    },
    "connectors": [
      { "id": "…", "name": "…", "description": "…", "auth_mode": "…", "definition": "<JSON string>" }
    ],
    "server_version": "…"
  }
  ```
- 特殊行为（统一下发配置）：
  - `models` = `llmgateway.ListModels`（排除 `catalog_missing` 模型）；`default_model` 读 settings `gateway.default_model`，不在 enabled models 时回落 `models[0].id` 或 `""`。
  - `skills` 按授权过滤（admin 全量；其余按 `UserEffectiveGroups` + 部门隔离授权）。
  - `web.error_reporting_dsn` 空 = 客户端不启用错误上报；`error_reporting_enabled`/`error_reporting_heartbeat` 仅显式 `"true"` 才为 true；`error_reporting_level` 缺省 `"error"`；`default_thinking_level` 缺省 `"max"`（合法集 `{off,low,high,max}`）。
  - `connectors` 只下发 enabled 连接器；`id == "glitchtip"` 的 `definition` 会注入 `GLITCHTIP_BASE_URL`/`GLITCHTIP_ORGANIZATION` 到 tokenFields 的 defaultValue。
  - `server_version` = `serverauth.BuildVersion()`，当前仅诊断/溯源，客户端版本检查走 `updates/manifest` 的 `server.version`。

> 相关探针（非「统一下发配置」范畴，同属 `bootstrap.Handlers`）：`GET /healthz` —— DB ping（3s 超时）；成功 200 `{"ok":true}`；失败 503 `{"ok":false,"error":{"code":"INTERNAL","message":"db unavailable"}}`。

---

# 5. 遥测（telemetry）

## 5.1 POST /api/client/v2/telemetry/skill-call
- 鉴权：BearerToken
- 请求体：
  ```json
  { "name": "…", "version": "…" }
  ```
  （`version` 可选）
- 错误：
  - 请求体格式错 → 400 `VALIDATION`「请求体格式错误」
  - `name` 空 / 长度 > 128 / 含 `/` 或 `\` → 400 `VALIDATION`「skill name 不合法」
  - `version` 长度 > 128 → 400 `VALIDATION`「version 不合法」
  - 限流超限 → 429 `RATE_LIMITED`「上报过于频繁,请稍后再试」
  - 落库失败 → 500 `INTERNAL`「记录失败」
- 成功响应 200：`{ "ok": true }`
- 特殊行为：
  - 双桶滑动窗口限流：per-user 60/min（env `PICOAI_TELEMETRY_MAX_PER_MIN`）、per-skill 10/min（env `PICOAI_TELEMETRY_MAX_PER_SKILL_PER_MIN`），0 = 不限。
  - 可见性判定：目标技能不可见（非 admin / 非作者 / 未授权）时静默返回 200 不落库；本地技能（服务端不存在）同样静默 200。

## 5.2 POST /api/client/v2/telemetry/error-reporting
- 鉴权：BearerToken
- 请求体（除 `state` 全可选）：
  ```json
  { "state": "ready", "reason": "…", "dsn_host": "…", "level": "error", "release": "…" }
  ```
- 错误：
  - 请求体格式错 → 400 `VALIDATION`「请求体格式错误」
  - 限流超限 → 429 `RATE_LIMITED`「上报过于频繁,请稍后再试」
  - 落库失败 → 500 `INTERNAL`「记录失败」
- 成功响应 200：`{ "ok": true }`
- 特殊行为：
  - `state` 白名单 `{idle,disabled,ready,failed,config_unavailable}`，不在白名单 → 200 不落库（静默）。
  - `dsn_host` 须为裸主机名（`[A-Za-z0-9.-]`，可带数字端口 1–65535，首尾非 `.`/`-`，长度 ≤ 253），否则清空。
  - `level` 白名单 `{"",debug,info,warning,error}`，否则清空。
  - `reason`/`release` 经控制字符剥离 + `TruncateRunes`（上限 200 / 64）。
  - 限流 10/min（env `PICOAI_TELEMETRY_ERROR_REPORTING_MAX_PER_MIN`）。
  - 这是「客户端错误上报状态」遥测（客户端 Sentry SDK 直接向 `web.error_reporting_dsn` 上报，服务端只收状态摘要，**不代理**摄取）。

## 5.3 GET /api/server/admin/gateway/error-reporting/clients
- 鉴权：AdminSession + `gateway:read`
- 成功响应 200：
  ```json
  {
    "ready": 0, "disabled": 0, "failed": 0, "config_unavailable": 0, "idle": 0,
    "last_report_at": "",
    "total": 0,
    "items": [
      { "username": "…", "state": "ready", "reason": "…", "dsn_host": "…", "level": "…", "release": "…", "updated_at": "<RFC3339>" }
    ]
  }
  ```
- 错误：查询失败 → 500 `INTERNAL`「查询失败」
- 特殊行为：`items` 上限 100（按 `updated_at` 倒序）；`total` = 全表行数（非 `items` 长度）；`last_report_at` = `items[0].updated_at`（空数据为 `""` —— 管理端据此渲染「还没有任何客户端上报」，而非「一切正常」）。

## 5.4 POST /api/server/admin/gateway/error-reporting/test
- 鉴权：AdminSession + `gateway:write`
- 请求体（可空体；`dsn` 可选）：
  ```json
  { "dsn": "https://<key>@<host>/<projectID>" }
  ```
- 错误：
  - 坏体（非 EOF）→ 400 `VALIDATION`「请求体格式错误(需要 JSON 对象,dsn 为可选字符串)」
  - `dsn` 显式空串 → 400 `VALIDATION`「dsn 不能为空(省略该字段才会使用已保存的 DSN)」
  - 未配置 DSN → 400 `VALIDATION`「尚未配置错误上报 DSN,无法发送测试事件」
  - DSN 校验拒绝 → 400 `VALIDATION`（DSN 校验器文案，见下）
- 成功响应 200（服务端向 DSN 推导的 GlitchTip/Sentry 兼容摄取端点 `POST /api/{projectID}/store/` 代发一条测试事件）：
  ```json
  {
    "ok": true,
    "event_id": "<32 位十六进制>",
    "http_status": 200,
    "endpoint": "https://<host>/api/1/store/",
    "elapsed_ms": 12,
    "note": "本结果由服务端发起,证明服务端到上报地址可达;员工客户端的网络环境可能不同"
  }
  ```
- 失败响应 502（含诊断 `detail`，原始失败详情不进响应）：
  ```json
  {
    "error": { "code": "UPSTREAM", "message": "…" },
    "detail": { "kind": "CONNECT", "endpoint": "https://<host>/api/1/store/", "note": "…", "http_status": 0, "elapsed_ms": 3 }
  }
  ```
- 特殊行为：
  - `kind`（失败类别，封闭集合）：`DNS` / `CONNECT` / `TLS` / `TIMEOUT` / `BLOCKED` / `HTTP_3XX` / `HTTP_4XX` / `HTTP_5XX` / `CANCELED` / `UNKNOWN`。
  - DSN 校验（`InspectErrorReportingDSN`）要求：小写 `http(s)` 协议、ASCII 域名或 IPv4（拒 IDN/IPv6 字面量）、公钥含可空私钥只能字母/数字/下划线、项目 ID 为 int64 且 > 0、端口非空等；`https` 或回环/私网 `http` 放行（内网自建 GlitchTip 为合法场景）。
  - 摄取端点格式：`{scheme}://{host}[:port]{prefix}/api/{projectID}/store/`（不跟随重定向，不携带公钥）。
  - 审计：`error_reporting_test`（成功 detail=`endpoint=… ok http=N`，失败 detail=`endpoint=… kind=…`）。

---

# 6. 报表订阅（report-subscriptions）

订阅对象（管理端响应体，`hook_url` 统一脱敏为 `"***"`；空为 `""`）：

```json
{
  "id": 1, "name": "…", "enabled": true, "hook_url": "***",
  "last_run_at": "<RFC3339>", "last_error": "…", "pending_period": "YYYY-MM",
  "fail_streak": 0, "next_attempt_at": "<RFC3339>", "created_at": "<RFC3339>", "updated_at": "<RFC3339>"
}
```

（`last_run_at`/`pending_period`/`next_attempt_at` 未产生时为空/缺省；`last_error` 为经 `SanitizeReportError` 消毒后的文案。）

## 6.1 GET /api/server/admin/report-subscriptions
- 鉴权：AdminSession + `report:read`
- 成功响应 200：`{ "subscriptions": [ …订阅对象… ] }`

## 6.2 POST /api/server/admin/report-subscriptions
- 鉴权：AdminSession + `report:write`
- 请求体：
  ```json
  { "name": "…", "hook_url": "…", "enabled": true }
  ```
  （`enabled` 缺省 `true`）
- 错误：
  - 请求体格式错 → 400 `VALIDATION`「请求体格式错误」
  - `name` 空 → 400 `VALIDATION`「订阅名称必填」
  - `hook_url` 非法 → 400 `VALIDATION`「hook_url 必须是 http(s) URL」/「hook_url 不合法: …」
- 成功响应 201：`{ "id": 1 }`
- 特殊行为：审计 `report_subscription_create`（detail=`name (id=N)`）。

## 6.3 PUT /api/server/admin/report-subscriptions/:id
- 鉴权：AdminSession + `report:write`
- 请求体：同 6.2（PATCH 语义：`hook_url` 留空或 `"***"` = 保持现值；`enabled` 省略 = 保持现值）
- 错误：
  - id 非法 → 400 `VALIDATION`「无效 ID」
  - 不存在 → 404 `NOT_FOUND`「订阅不存在」
- 成功响应 200：`{ "ok": true }`
- 特殊行为：审计 `report_subscription_update`；地址真的变更时归零 `fail_streak`/`next_attempt_at`、清 `last_error`（不触碰 `pending_period`）。

## 6.4 DELETE /api/server/admin/report-subscriptions/:id
- 鉴权：AdminSession + `report:write`
- 错误：400 `VALIDATION`「无效 ID」/ 404 `NOT_FOUND`「订阅不存在」
- 成功响应 200：`{ "ok": true }`
- 特殊行为：审计 `report_subscription_delete`（detail=id）。

## 6.5 POST /api/server/admin/report-subscriptions/:id/test
- 鉴权：AdminSession + `report:write`
- 错误：400 `VALIDATION`「无效 ID」/ 404 `NOT_FOUND`「订阅不存在」/ 推送失败 → 502 `UPSTREAM`「推送失败: <消毒后文案>」
- 成功响应 200：`{ "ok": true, "period": "YYYY-MM" }`
- 特殊行为：即时生成上一自然月（北京时间）月报并推送到该订阅 `hook_url`。

### 月报推送体（webhook 收到的 JSON）

```json
{
  "type": "monthly_usage_report",
  "period": "YYYY-MM",
  "generated_at": "<RFC3339>",
  "total": { "cost": 1.23, "requests": 100, "tokens": 5000 },
  "top_models": [ { "label": "…", "cost": 1.0, "requests": 10, "tokens": 1000 } ],
  "top_users":  [ { "label": "…", "cost": 1.0, "requests": 10, "tokens": 1000 } ],
  "departments": [ { "label": "…", "cost": 1.0, "requests": 10, "tokens": 1000 } ]
}
```

（`top_models`/`top_users` 前 10、`departments` 前 20，按 cost 降序、等值按 label 升序；`tokens = prompt + completion − embed`。条目字段形状待确认——源码只展开到 `{label,cost,requests,tokens}` 聚合维度。）

### 重试退避

- 推送失败：`fail_streak += 1`、写 `last_error`（消毒）、`next_attempt_at = now + delay`、首次失败写 `pending_period`（后续保留）。
- `delay`：`fail_streak` 为 0→1 时 1h（`reportRetryFirstDelay`）；≥2 时 24h（`reportRetryMaxDelay`）。即 `nextAttemptAfterFailure(now, failStreak+1)`。
- 推送成功：`last_run_at=now`、清 `last_error`、`fail_streak=0`、`next_attempt_at=null`、推进 `pending_period` 游标。
- 出站 SSRF 防护：不跟随重定向，目标经 `blockedHookCIDRList` 复检（私网/回环/链路本地/CGNAT/NAT64/6to4/Teredo 等）。

---

# 7. 审计日志（audit）

审计条目对象（`AuditLogEntry`）：

```json
{ "id": 1, "username": "…", "action": "…", "detail": "…", "prev_hash": "…", "hash": "…", "created_at": "<RFC3339>", "app_id": "" }
```

## 7.1 GET /api/server/admin/audit
- 鉴权：AdminSession + `audit:read`
- query 参数：`page`（缺省 1）、`size`（缺省 50、上限 500，经 `paginate(c,50,500)`）、`action`（可选）、`username`（可选）
- 成功响应 200：
  ```json
  { "logs": [ …审计条目… ], "total": 123 }
  ```
- 特殊行为：无 `report:read` 权限的管理员，条目 `detail` 被读侧脱敏（`RedactAuditDetailForViewer`，不改库）。

## 7.2 GET /api/server/admin/audit/settings
- 鉴权：AdminSession + `audit:read`
- 成功响应 200：`{ "retention_days": 180 }`

## 7.3 PUT /api/server/admin/audit/settings
- 鉴权：AdminSession + `audit:retention:write`
- 请求体：`{ "retention_days": 180 }`（`*int`）
- 错误：
  - 缺 `retention_days`/绑定失败 → 400 `VALIDATION`「retention_days 必填」
  - `<1` 或 `>3650` → 400 `VALIDATION`「retention_days 必须在 1~3650 天之间」
  - 保存失败 → 500 `INTERNAL`「保存失败」
- 成功响应 200：`{ "retention_days": 180 }`
- 特殊行为：保存后**立即额外触发一次**过期清理（`PurgeOldAuditLogs(now − days*24h)`，失败不影响保存）；审计 `audit_retention_change`（detail=`old→new`）。

### 审计哈希链

- 算法：`hash = sha256(prev_hash | username | action | detail | created_at)`（`created_at` 为 UTC RFC3339 字符串；写入前 `username`/`detail` 经 `util.EscapeControl`）。带 `app_id` 的 v2 链追加 `|app_id`（`hash_version` 1/2）。
- `prev_hash` 指向上一条已落库条目的 `hash`；写入经 PG advisory 事务锁（`auditChainLockKey = 0x5069636F`「Pico」）串行化。
- 校验（`VerifyAuditChain`）：从旧到新逐条重算；首行只校验自身（清理后锚）；pre-0048 空 hash 行跳过；断链返回首个失败 id + 「audit chain broken at entry」/「audit hash mismatch」。
- 写入 worker：每 DB 单 worker 串行 + 攒批（≤20 条或 2ms），空闲 60s 退出；重试 2 轮（backoff 20ms）；SAVEPOINT 逐条隔离。
- 保留清理：`DELETE created_at < cutoff` 且存在更晚的同批行（保留链锚）。

---

# 8. 服务器信息（server-info）

## 8.1 GET /api/server/admin/server-info
- 鉴权：AdminSession + `server-info:read`
- 错误：DB 统计失败 → 500 `INTERNAL`「统计失败: …」
- 成功响应 200：
  ```json
  {
    "uptime_sec": 123456,
    "uptime_human": "1天10时16分",
    "go_version": "go1.26.6",
    "num_cpu": 8,
    "gomaxprocs": 8,
    "goroutines": 123,
    "mem": { "allocated_mb": 12.3, "total_system_mb": 45.6, "system_memory_mb": 789.0 },
    "load_avg": [0.1, 0.2, 0.3],
    "disk": { "data_path": "/data", "total_gb": 100.0, "used_gb": 20.0, "free_gb": 80.0, "used_pct": 20.0 },
    "db": {
      "driver": "pg",
      "tables": { "users": 10, "audit_logs": 100 },
      "total_rows": 500,
      "disk_bytes": 123456,
      "disk_human": "120.6MB",
      "schema_migrations": 85
    },
    "version": "dev",
    "update_check": {
      "current": "dev", "latest": "v2.7.0", "update_available": true,
      "image_tag": "v2.7.0", "manifest_url": "…", "checked_at": "<RFC3339>"
    },
    "balance": {
      "admission_rejections": 3,
      "last_rejection": {
        "user_id": 1, "username": "…", "endpoint": "chat", "model": "…",
        "reason": "non_positive", "required_money": 0.0, "balance_money": 0.0, "at": "<RFC3339>"
      }
    },
    "oidc": { "capacity_rejections": 0 },
    "audit": {
      "chain_checked": true, "chain_intact": true, "chain_broken_id": 0,
      "chain_checked_at": "<RFC3339>", "chain_age_seconds": 60, "chain_stale": false,
      "chain_source": "periodic", "chain_checks": 10, "chain_rows": 1000, "chain_duration_ms": 5,
      "chain_error": "",
      "write_failures": 0, "dropped_entries": 0, "retries": 0,
      "last_failure": {
        "reason": "…", "action": "…", "username": "…", "cause": "…", "cause_class": "sqlstate:<码>", "at": "<RFC3339>"
      }
    }
  }
  ```
- 特殊行为：
  - `update_check` 为实时版本检查结果，失败/服务不可达时为 `null`（前端静默降级）。
  - `balance.admission_rejections` 是余额准入闸门拒绝计数（进程内，重启归零）；`last_rejection.reason` 封闭集合 `non_positive | learned_floor | min_billable | unpriced_model | unbillable_price`。
  - `audit` 是审计链 + 审计写入健康快照（只读，不含审计内容）；`chain_stale` 判据为 `AuditChainStaleAfter=2h`；`chain_source` ∈ `{startup, periodic}`；`last_failure` 仅在有过写入失败时出现。
  - `db.tables` 为字面量表名→行数（users/groups/user_groups/settings/api_tokens/gateway_providers/models/usage/apps/app_releases/app_grants/audit_logs/admin_sessions），缺表跳过。

---

# 9. 后台调度（background schedulers）

| 调度器 | 源码 | 触发周期 | 做的事 |
|---|---|---|---|
| 余额月度发放 | `server/internal/balance/scheduler.go` | 每 10 分钟（启动先跑一轮再进 ticker） | `GetBalanceSettings` → `MonthlyAmount<=0` 跳过 → `GrantMonthlyBalance`（逐人·月幂等锚 `balance_grant_items(user_id, month)`）；审计 `balance_grant`（actor=`system`，detail=`month=… mode=… granted=… skipped=…`） |
| 审计哈希链校验 | `server/internal/auditchain/scheduler.go` | 每 1 小时（第一轮在**一个 tick 之后**，因启动已校验过） | `RunAndRecordPeriodicAuditChainCheck`；「断链」不计 errors（只看 brokenID）；日志 `audit chain verified: intact` / `audit chain BROKEN at entry id=` |
| 审计保留清理 | `server/internal/auditretention/scheduler.go` | 每 6 小时（启动先跑一轮再进 ticker） | `AuditRetentionDays(db)`（≤0 回落 180）→ `cutoff = now − days*24h` → `PurgeOldAuditLogs`；日志 `purged N audit entr(ies) older than …`。另：`PUT /api/server/admin/audit/settings` 保存时额外立即触发一次 |
| 报表订阅投递 | `server/internal/reports/scheduler.go` | 每 1 小时（启动先跑第一轮再进 ticker） | `tryRun` 按 `SubscriptionDuePeriod` 判定 → `DispatchAll`（PG advisory lock class=`0x52505431`「RPT1」，按订阅 id，两阶段：锁内重判 → 生成 → 锁内再重判 → 推送 → 落账）；成功推进 pending 游标，失败按退避写 `fail_streak`/`next_attempt_at` |

各调度器可观测出口：`Started` / `StartedAt` / `Runs` / `Errors` / `LastRunAt` / `LastError` / `Tick`。
