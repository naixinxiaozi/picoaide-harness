# 认证 + 用户 + 部门 + 余额 + 用量管理 API 契约

> 提取自 Go 源码（唯一真源：`server/internal/router/router.go` 路由表 + `server/internal/serverauth/*.go` 非测试 handler）。
> 所有端点返回 JSON。成功用 `c.JSON(...)`；失败统一信封 `{"error":{"code","message"}}`（经 `serverauth.WriteError`）。

## 通用约定

- **命名空间**：客户端面 `/api/client/v2/*`；管理面 `/api/server/admin/*`。
- **请求体上限**：客户端面 1 MiB（`bodyLimitMiddleware`，`maxJSONBody=1<<20`）；管理面 `adminMaxBodyBytes=1<<20`。
- **鉴权标签**：`public` / `BearerToken`（客户端 bearer，`serverauth.BearerAuth`）/ `AdminSession`（管理会话 + CSRF，`serverauth.AdminAuth`）/ `AdminSession+权限点`（RBAC，`AdminRoute` 申报）。
- **错误码集合**（信封 `code` 字段取值）：`AUTH_REQUIRED`、`AUTH_FAILED`、`FORBIDDEN`、`NOT_FOUND`、`VALIDATION`、`UPSTREAM`、`RATE_LIMITED`、`INTERNAL`、`PASSWORD_CHANGE_REQUIRED`、`BALANCE_EXHAUSTED`、`APPROVED_NOT_REJECTABLE`、`APP_DELISTED`、`MODEL_NOT_PRICED`、`CSRF_EXPIRED`、`AUDITOR_NOT_ALLOWED`；另有 `MFA_ALREADY_ENABLED`（409，MFA 专用）。
- **权限点全名**（`rbac.go`）：`user:read`、`user:write`、`dept:read`、`dept:write`、`auth:read`、`auth:write`、`gateway:read`、`gateway:write`、`usage:read`、`report:write`、`report:read`、`market:read`、`market:write`、`capability:read`、`capability:write`、`connector:read`、`connector:write`、`audit:read`、`audit:retention:write`、`portal:read`、`portal:write`、`server-info:read`。角色 → 权限：`super_admin`=全量；`auditor`=`[audit:read,usage:read,user:read]`；`user`=空。
- **管理面 CSRF**：`AdminAuth` 对非 GET/HEAD 要求 `X-CSRF-Token` 请求头；失败 → 403 `CSRF_EXPIRED`「CSRF 校验失败,请刷新页面重试」。会话 cookie 名 `picoaide_session`（HttpOnly、SameSite=Lax、Secure 按部署、TTL 12h、空闲超时 60min）。
- **分页**：管理面统一 `paginate(c, defaultSize, maxSize)`——`page` 非法/`<1` → 1，`>100000` → 100000；`size` 非法/越界 → `defaultSize`。缺省 `page=1`。
- **金额精度**：对外输出/闸门判定均走 `serverstore.QuantizeMoney`（分位四舍五入）；账本精度微元 `1e-6`。

## 通用嵌套结构

### `userJSON`（用户对象，多处复用）
| key | 类型 | 说明 |
|---|---|---|
| `id` | int64 | |
| `username` | string | |
| `display_name` | string | |
| `email` | string | |
| `is_admin` | bool | |
| `role` | string | `super_admin` / `auditor` / `user` |
| `permissions` | []string | `PermissionsOf(role)` |
| `status` | int | 1=启用，0=禁用 |
| `balance_money` | float | `QuantizeMoney` 分位 |
| `balance_activated` | bool | `!BalanceActivatedAt.IsZero()` |
| `source` | string | `local` / `external` |
| `password_changeable` | bool | `source=="local" && PasswordHash!="" && status==1` |
| `password_must_change` | bool | |
| `password_changed_at` | string(RFC3339) | |
| `mfa_enabled` | bool | `TotpEnabled` |

### `tokenJSON`（令牌管理视图）
| key | 类型 |
|---|---|
| `id` | int64 |
| `name` | string |
| `created_at` | string(RFC3339) |
| `expires_at` | string(RFC3339) |
| `last_used_at` | string(RFC3339，可为 `""`) |
| `revoked` | int |

---

# 1. 客户端 auth（`/api/client/v2/auth/*`）

## 1.1 POST /api/client/v2/auth/login
- 鉴权：public
- 请求体：
  - `username` (string, required)
  - `password` (string, required)
- 错误：
  - 请求体格式错或 `username` 空 → 400 `VALIDATION`「请求体格式错误」
  - `len(username)>128` 或 `len(password)>1024` → 400 `VALIDATION`「用户名或密码过长」
  - 认证服务未配置 → 500 `INTERNAL`「认证服务未配置」
  - argon2 并发闸满 → 429 `RATE_LIMITED`「登录请求过于频繁,请稍后再试」
  - 凭证错 → 401 `AUTH_FAILED`「用户名或密码错误」
  - 身份冲突 → 401 `AUTH_FAILED`「该用户名已绑定到其它身份源账号,请联系管理员」
  - `status!=1` → 401 `AUTH_FAILED`「账号已禁用」
  - `role==auditor` → 401 `AUDITOR_NOT_ALLOWED`「审计账号不可登录客户端,请使用管理后台」
  - 限流 → 429 `RATE_LIMITED`
- 成功响应 200：
  ```json
  { "token": "<bearer>", "user": { …userJSON… }, "must_change_password": false }
  ```
- 特殊行为：本地密码经 argon2id 校验（`acquirePasswordVerify` 并发闸，64 MiB/次）；外部身份（ldap/oidc）首次登录 `provisionUser` 建行 + 绑定外部身份 + `SyncUserGroups`；审计 `login_success`/`login_fail`（含 `ip=`）；token TTL 90 天（`IssueToken`，32 字节随机 `base64.RawURLEncoding`，库中只存 SHA-256）。

## 1.2 POST /api/client/v2/auth/logout
- 鉴权：BearerToken
- 请求体：无
- 成功响应 200：`{ "ok": true }`
- 特殊行为：吊销当前 bearer（按哈希 `RevokeToken`）+ `OnSessionRevoked` 通知会话键失效。

## 1.3 GET /api/client/v2/auth/me
- 鉴权：BearerToken（白名单豁免 `PASSWORD_CHANGE_REQUIRED`）
- 请求体：无
- 成功响应 200：`{ "user": { …userJSON… } }`

## 1.4 GET /api/client/v2/auth/usage
- 鉴权：BearerToken
- 请求体：无
- 成功响应 200（字段为跨语言契约，`usage_contract_test.go` 与 `account-card` 对拍）：
  ```json
  {
    "balance_money": 0.0,
    "balance_activated": false,
    "balance_enabled": false,
    "balance_monthly": 0.0,
    "balance_mode": "add",
    "is_admin": false,
    "monthly_usage": 0,
    "monthly_cost": 0.0,
    "today_usage": 0,
    "today_cost": 0.0,
    "yesterday_usage": 0,
    "yesterday_cost": 0.0,
    "total_usage": 0,
    "total_cost": 0.0
  }
  ```
- 特殊行为：`balance_*` 来源 `BalanceSettings`；`is_admin`=`u.IsAdmin`；用量/费用为 token 计数与元（cost）。

## 1.5 POST /api/client/v2/auth/password
- 鉴权：BearerToken（白名单豁免 `PASSWORD_CHANGE_REQUIRED`）
- 请求体：
  - `old_password` (string, required)
  - `new_password` (string, required)
- 错误：
  - `>1024` → 400 `VALIDATION`「密码过长」
  - `new_password` 短于 `AuthMinPasswordLength`（默认 10，可配 8~64）→ 400 `VALIDATION`「密码至少 N 位」
  - `source!="local"` 或无本地密码哈希 → 400 `VALIDATION`「外部认证用户的密码由企业 IdP 管理,不能在此修改」
  - 旧密码错 → 401 `AUTH_FAILED`「原密码错误」
  - 新旧相同 → 400 `VALIDATION`「新密码不能与原密码相同」
- 成功响应 200：`{ "ok": true }`
- 特殊行为：改密后吊销该用户全部 `api_tokens`（`UpdateUserPassword` 内 DELETE）+ `notifyUserSessionsRevoked` + 审计 `password_change`/`self`。

## 1.6 GET /api/client/v2/auth/methods
- 鉴权：public
- 请求体：无
- 成功响应 200：
  ```json
  { "methods": [ { "name": "local", "configured": true, "browser": false, "hidden": false } ] }
  ```
- 特殊行为：`name` ∈ `local|ldap|oidc|openid`；`configured` 由运行期 provider 注册表判定（LDAP 必填 `server_url`/`bind_dn`/`base_dn`；oidc/openid 必填 `issuer`/`client_id`/`redirect_url`）；`browser=true` 仅 oidc/openid；`hidden=true` 仅 local 且 `auth.hide_local=true`。`local` 恒在列表（admin 回退）。

## 1.7 GET /api/client/v2/auth/oidc/login 与 GET /api/client/v2/auth/openid/login
- 鉴权：public
- query：`server` (string, optional)——发起登录的桌面客户端服务端地址（深链回跳用）
- 错误：
  - 未配置 provider → 404 `NOT_FOUND`
  - `server` 格式错 → 400 `VALIDATION`「server 参数格式错误」
  - `server` 非 https（或 http 回环）→ 400 `VALIDATION`「server 必须为 https(或 http 回环)」
  - `server` 与配置声明的来源不一致 → 400 `VALIDATION`「server 与本次登录的服务端不一致」
  - 在途流程表满/单 IP 配额满 → 429 `RATE_LIMITED`「登录请求过于频繁,请稍后再试」
  - provider 协议/配置错误 → 502 `UPSTREAM`「OIDC 服务不可用」
  - 状态生成失败 → 500 `INTERNAL`「状态生成失败」
- 成功：302 重定向到 IdP 授权 URL（authorization code + PKCE S256 + nonce）；同时写 `picoaide_oidc_state_<name>` cookie（HttpOnly、SameSite=Lax、Path=`/api/client/v2/auth/<name>`、TTL 10min）。
- 特殊行为：state 单次有效，TTL 10min，全局在途流程 ≤1000，单 IP ≤100；限流只对真实失败计数（成功不记账、不 reset）。

## 1.8 GET /api/client/v2/auth/oidc/callback 与 GET /api/client/v2/auth/openid/callback
- 鉴权：public
- query：`code` (string, required)、`state` (string, required)
- 错误：
  - 缺 `code`/`state` → 400 `VALIDATION`「缺少 code 或 state」
  - state 与 cookie 不匹配 → 400 `VALIDATION`「state 与登录浏览器不匹配」
  - 回调限流 → 429 `RATE_LIMITED`
  - state 无效/已过期 → 400 `VALIDATION`「state 无效或已过期」
  - OIDC 校验失败 → 401 `AUTH_FAILED`「OIDC 认证失败」
  - 身份冲突 → 401 `AUTH_FAILED`「该用户名已绑定到其它身份源账号,请联系管理员」
  - 用户建行失败 → 500 `INTERNAL`「用户创建失败」
  - `status!=1` → 401 `AUTH_FAILED`「账号已禁用」
  - `role==auditor` → 401 `AUDITOR_NOT_ALLOWED`
- 成功：302 重定向到深链 `<scheme>://auth?token=<urlencoded>&server=<urlencoded 可选>&user=<urlencoded 可选>`（`scheme` 随渠道 `DeepLinkScheme`）。
- 特殊行为：state 单次消费；OIDC 身份主体绑定 `sub`（`ExternalID`），用户名取 `preferred_username` → `email` → `sub`；审计 `login_success`/`login_fail`。

---

# 2. 管理端 auth（`/api/server/admin`）

## 2.1 POST /api/server/admin/login
- 鉴权：public
- 请求体：
  - `username` (string, required)
  - `password` (string, required)
- 错误：
  - 任一空 → 400 `VALIDATION`「请求体格式错误」
  - 限流（三桶：ip/user/srcIP，任一拒绝）→ 429 `RATE_LIMITED`「登录尝试过于频繁,请稍后再试」
  - argon2 并发闸满 → 429 `RATE_LIMITED`「登录请求过于频繁」
  - 非管理员或凭证错 → 401 `AUTH_FAILED`「用户名或密码错误或非管理员」
- 成功响应 200：
  - 无 MFA：`{ "csrf_token": "<token>", "user": { …userJSON… }, "must_change_password": false }`
  - 已开 MFA：`{ "mfa_required": true, "mfa_ticket": "<ticket>" }` + 审计 `admin_mfa_login`「challenge issued」
- 特殊行为：仅本地账号（`AuthenticateConfiguredAdmin` local-only），且 `HasManagementAccess`（super_admin 或 auditor）；session 库只存 `secret_hash`（SHA-256）；`csrf_token` = `IssueSessionCSRF`（HMAC-SHA256）。

## 2.2 POST /api/server/admin/login/mfa
- 鉴权：public
- 请求体：
  - `mfa_ticket` (string, required)
  - `code` (string, required)
- 错误：
  - 任一空 → 400 `VALIDATION`「请求体格式错误」
  - 限流（mfa-ip / mfa-user）→ 429 `RATE_LIMITED`「验证尝试过于频繁」
  - 挑战占用失败/已失效 → 401 `AUTH_FAILED`「验证请求已失效,请重新登录」
  - 动态码错/已失效 → 401 `AUTH_FAILED`「动态码错误或已失效」
- 成功响应 200：`{ "csrf_token": "<token>", "user": { …userJSON… }, "must_change_password": false }`
- 特殊行为：`reserveMFAChallenge` 原子占用（attempts 上限 5，单条 UPDATE…RETURNING）；`verifyAndConsumeTOTP` 防重放（同一 (user,step) 只能成功一次）；`consumeMFAChallenge` 单次消费。

## 2.3 GET /api/server/admin/auth/methods
- 鉴权：public
- 请求体：无
- 成功响应 200：同 §1.6（`{ "methods": [ … ] }`）。
- 特殊行为：与客户端面共用 `publicAuthMethods` 实现；管理端不消费 `hidden`。

## 2.4 GET /api/server/admin/me
- 鉴权：AdminSession（perm=""，仅需有效会话；白名单豁免 `PASSWORD_CHANGE_REQUIRED`）
- 请求体：无
- 成功响应 200：`{ "user": { …userJSON… }, "csrf_token": "<token>" }`

## 2.5 POST /api/server/admin/logout
- 鉴权：AdminSession（perm=""；白名单豁免 `PASSWORD_CHANGE_REQUIRED`）
- 请求体：无
- 成功响应 200：`{ "ok": true }`
- 特殊行为：`DeleteAdminSession` 删除当前会话。

## 2.6 POST /api/server/admin/me/password
- 鉴权：AdminSession（perm=""；白名单豁免 `PASSWORD_CHANGE_REQUIRED`）
- 请求体：
  - `old_password` (string, required)
  - `new_password` (string, required)
- 错误：
  - `>1024` → 400 `VALIDATION`
  - `new_password` 短于最小长度 → 400 `VALIDATION`
  - `source!="local"` → 400 `VALIDATION`「外部认证用户的密码由企业 IdP 管理,不能在此修改」
  - 旧密码错 → 401 `AUTH_FAILED`
  - 新旧相同 → 400 `VALIDATION`
- 成功响应 200：`{ "ok": true }`
- 特殊行为：改密后吊销全部 `api_tokens` + 审计 `admin_password_change`/`self`。

## 2.7 GET /api/server/admin/me/mfa
- 鉴权：AdminSession（perm=""）
- 请求体：无
- 成功响应 200：`{ "enabled": <bool> }`

## 2.8 POST /api/server/admin/me/mfa/enable
- 鉴权：AdminSession（perm=""）
- 请求体：
  - `password` (string, required)
- 错误：
  - 已开启 → 409 `MFA_ALREADY_ENABLED`
  - `source!="local"` 或密码错 → 401 `AUTH_FAILED`「主密码错误」
  - 密码校验并发闸 → 429 `RATE_LIMITED`
- 成功响应 200：`{ "secret": "<TOTP 明文密钥>", "otpauth_url": "<otpauth://...>", "ticket": "<enable ticket>" }`
- 特殊行为：明文密钥仅此一次下发前端，库中 AES-GCM 密文；`ticket` TTL 60s（`mfaEnableTicketTTL`）。

## 2.9 POST /api/server/admin/me/mfa/verify
- 鉴权：AdminSession（perm=""）
- 请求体：
  - `ticket` (string, required)
  - `code` (string, required)
- 错误：
  - 任一空 → 400 `VALIDATION`「请求体格式错误」
  - 挑战失效 → 401 `AUTH_FAILED`「验证请求已失效,请重新开启」
  - 动态码错 → 401 `AUTH_FAILED`「动态码错误」
  - 账号已开启（并发/陈旧 ticket）→ 409 `MFA_ALREADY_ENABLED`
- 成功响应 200：`{ "enabled": true }`
- 特殊行为：`SetUserMFA` 写入带 `totp_enabled=0` 谓词（防覆盖已登记密钥）；开启后删除其他 `admin_sessions`（防绕过 MFA 的存量登录）。

## 2.10 POST /api/server/admin/me/mfa/disable
- 鉴权：AdminSession（perm=""）
- 请求体：
  - `password` (string, required)
  - `code` (string, required)
- 错误：
  - 未开启 → 400 `VALIDATION`「MFA 未开启」
  - `source!="local"` 或主密码错 → 401 `AUTH_FAILED`「主密码错误」
  - 密码校验并发闸 → 429 `RATE_LIMITED`
  - 动态码错 → 401 `AUTH_FAILED`「动态码错误」
- 成功响应 200：`{ "enabled": false }`
- 特殊行为：主密码 + 当前动态码双验（换验证器必须先 disable）；`ClearUserMFA` 清密钥；删除其他会话。

---

# 3. users（`/api/server/admin/users*` + tokens）

## 3.1 GET /api/server/admin/users
- 鉴权：AdminSession+`user:read`
- query：
  - `page` (int, optional, 默认 1)
  - `size` (int, optional, 默认 20, 最大 200)
  - `q` (string, optional)——搜索
- 错误：查询失败 → 500 `INTERNAL`「查询失败」
- 成功响应 200：
  ```json
  {
    "users": [ { …userJSON…, "groups": ["deptA"], "monthly_usage": 0, "monthly_cost": 0.0 } ],
    "total": 0, "page": 1, "size": 20
  }
  ```
- 特殊行为：`groups` 为部门名数组（空为 `[]`）；`monthly_usage`（本月 token）/`monthly_cost`（本月元）批量附取避免 N+1。

## 3.2 POST /api/server/admin/users
- 鉴权：AdminSession+`user:write`
- 请求体：
  - `username` (string, required)
  - `password` (string, required)
  - `role` (string, optional；空时由 `is_admin` 推导为 `super_admin`/`user`)
  - `is_admin` (bool, optional；兼容别名 `true→super_admin`)
  - `status` (int, optional, 默认 1；仅 0/1)
- 错误：
  - `username`/`password` 空 → 400 `VALIDATION`「用户名和密码必填」
  - `password` 短于最小长度 → 400 `VALIDATION`「密码至少 N 位」
  - `status` 非 0/1 → 400 `VALIDATION`「status 只能是 0 或 1」
  - `role` 非法 → 400 `VALIDATION`「role 必须是 super_admin/auditor/user」
  - 重复 → 400 `VALIDATION`「用户名已存在」
  - 用户名为空 → 400 `VALIDATION`「用户名不能为空」
  - 用户名过长（>128 字节）→ 400 `VALIDATION`「用户名过长（最多 N 字节）」
  - 创建失败 → 500 `INTERNAL`「创建失败」
- 成功响应 201：`{ "user": { …userJSON… } }`
- 特殊行为：`CreateUser(Source="local")`；审计 `user_create`。

## 3.3 PUT /api/server/admin/users/:id
- 鉴权：AdminSession+`user:write`
- path：`id` (int64, required)
- 请求体（全 optional，指针字段）：
  - `display_name` (*string)
  - `email` (*string)
  - `password` (*string)——非空时改密
  - `role` (*string)——显式优先于 `is_admin`
  - `is_admin` (*bool)——`true→super_admin`、`false→user`
  - `status` (*int)
  - `quota_tokens` (*int64)——**已下线，忽略**
  - `quota_clear` (bool)——**已下线，忽略**
  - `quota_money` (*float64)——**已下线，忽略**
  - `quota_money_clear` (bool)——**已下线，忽略**
- 错误：
  - `id` 非法 → 400 `VALIDATION`「非法用户 ID」
  - 用户不存在 → 404 `NOT_FOUND`「用户不存在」
  - `role` 非法 → 400 `VALIDATION`「role 必须是 super_admin/auditor/user」
  - 取消自己管理员权限 → 400 `VALIDATION`「不能取消自己的管理员权限」
  - 禁用自己 → 400 `VALIDATION`「不能禁用自己」
  - 外部用户改密 → 400 `VALIDATION`「外部认证用户的密码由企业 IdP 管理,不能在此修改」
  - 密码短于最小长度 → 400 `VALIDATION`「密码至少 N 位」
  - 更新失败 → 500 `INTERNAL`「更新失败」
- 成功响应 200：`{ "user": { …userJSON… } }`
- 特殊行为：改密/降权/禁用/任何角色变更 → `UpdateUserRevokingTokens` 吊销该用户全部 bearer + `notifyUserSessionsRevoked` + 审计 `user_tokens_revoked`；角色变更审计 `role_change`（`旧→新`），否则 `user_update`。

## 3.4 DELETE /api/server/admin/users/:id
- 鉴权：AdminSession+`user:write`
- path：`id` (int64, required)
- 错误：
  - `id` 非法 → 400 `VALIDATION`「非法用户 ID」
  - 用户不存在 → 404 `NOT_FOUND`「用户不存在」
  - 删除自己 → 400 `VALIDATION`「不能删除自己」
  - 最后一个管理员 → 400 `VALIDATION`「不能删除最后一个管理员」（`ErrLastAdmin`，事务内守卫）
  - 删除失败 → 500 `INTERNAL`「删除失败」
- 成功响应 200：`{ "ok": true }`
- 特殊行为：同一事务抹除 `api_tokens`/`usage` 明细/`usage_daily`/`usage_monthly`/`balance_ledger`/`balance_grant_items`/`admin_sessions`/组归属与用户级授权；抹除金额由 `ErasedUserLedgers` 返回并写入审计 `user_delete`（含「抹除用量 X 元/Y 笔、余额流水 X 元/Y 笔」）。

## 3.5 PUT /api/server/admin/users/:id/mfa
- 鉴权：AdminSession+`user:write`
- path：`id` (int64, required)
- 请求体：无
- 错误：
  - 对自己 → 400 `VALIDATION`「不能重置自己的 MFA,请在「安全设置」中关闭」
  - 目标不存在 → 404 `NOT_FOUND`「用户不存在」
  - 重置失败 → 500 `INTERNAL`「重置失败」
- 成功响应 200：`{ "ok": true }`
- 特殊行为：`ClearUserMFA` + `RevokeAllUserSessions`（api_tokens + admin_sessions）+ 审计 `admin_mfa_reset`。

## 3.6 GET /api/server/admin/users/:id/groups
- 鉴权：AdminSession+`user:read`
- path：`id` (int64, required)
- 错误：`id` 非法 → 400 `VALIDATION`；不存在 → 404 `NOT_FOUND`；查询失败 → 500 `INTERNAL`
- 成功响应 200：`{ "groups": ["deptA"] }`（空为 `[]`）

## 3.7 PUT /api/server/admin/users/:id/department
- 鉴权：AdminSession+`dept:write`
- path：`id` (int64, required)
- 请求体（`DisallowUnknownFields`，未知字段报错）：
  - `group_ids` ([]int64, optional；空数组=清空全部组)
  - `group_id` (int64, optional；旧单部门兼容，仅当 `group_ids` 为空时使用)
- 错误：
  - `id` 非法 → 400 `VALIDATION`「非法用户 ID」
  - 用户不存在 → 404 `NOT_FOUND`「用户不存在」
  - 请求体错误/未知字段 → 400 `VALIDATION`「请求体格式错误(仅接受 group_ids 数组或 group_id)」
  - 部门不存在 → 400 `VALIDATION`「部门不存在」
  - 保存失败 → 500 `INTERNAL`「保存失败」
- 成功响应 200：`{ "ok": true }`
- 特殊行为：替换式设置（`SyncUserGroups`）；`group_ids` 优先、去重、保序、`gid<=0` 跳过；审计 `user_dept`（`用户名 → [组名,…]`）。

## 3.8 GET /api/server/admin/users/:id/tokens
- 鉴权：AdminSession+`user:read`
- path：`id` (int64, required)
- query：
  - `page` (int, optional, 默认 1)
  - `size` (int, optional, 默认 50, 最大 200)
- 错误：`id` 非法/越界/非数字 → 400 `VALIDATION`；用户不存在 → 404 `NOT_FOUND`；`size` 超限 → 400 `VALIDATION`
- 成功响应 200：
  ```json
  { "tokens": [ { …tokenJSON… } ], "page": 1, "size": 50, "total": 0, "has_more": false }
  ```

## 3.9 POST /api/server/admin/tokens/:id/revoke
- 鉴权：AdminSession+`user:write`
- path：`id` (int64, required)
- 错误：`id` 非法 → 400 `VALIDATION`「非法令牌 ID」；令牌不存在 → 404 `NOT_FOUND`「令牌不存在」；撤销失败 → 500 `INTERNAL`「撤销失败」
- 成功响应 200：`{ "ok": true }`

---

# 4. departments（`/api/server/admin/departments*`）

部门模型：金字塔组织架构（`groups` 表，含 `parent_id`/`leader_id`）。

### `DepartmentInfo`（部门管理视图）
| key | 类型 |
|---|---|
| `id` | int64 |
| `name` | string |
| `parent_id` | int64 |
| `leader_id` | int64 |
| `leader_name` | string（`omitempty`） |
| `description` | string |
| `member_count` | int64 |
| `child_count` | int64 |
| `granted_count` | int64（授权引用数，删除守卫） |

## 4.1 GET /api/server/admin/departments
- 鉴权：AdminSession+`dept:read`
- 请求体：无
- 成功响应 200：`{ "departments": [ …DepartmentInfo… ] }`（空为 `[]`）
- 特殊行为：部门树平铺返回（含主管/成员数/子部门数/授权引用数）。

## 4.2 POST /api/server/admin/departments
- 鉴权：AdminSession+`dept:write`
- 请求体：
  - `name` (string, required)
  - `parent_id` (int64, optional)
  - `leader_id` (int64, optional)
  - `description` (string, optional)
- 错误：
  - `name` 空 → 400 `VALIDATION`「部门名称必填」
  - 名称重复 → 400 `VALIDATION`「部门名称已存在」
  - 上级部门/主管不存在 → 400 `VALIDATION`「上级部门或主管不存在」
  - 创建失败 → 500 `INTERNAL`「创建失败」
- 成功响应 201：`{ "department": { "id": <int64>, "name": "<name>" } }`
- 特殊行为：审计 `dept_create`。

## 4.3 PUT /api/server/admin/departments/:id
- 鉴权：AdminSession+`dept:write`
- path：`id` (int64, required)
- 请求体：同 §4.2（`name`/`parent_id`/`leader_id`/`description`）
- 错误：
  - `id` 非法 → 400 `VALIDATION`「非法部门 ID」
  - `name` 空 → 400 `VALIDATION`「部门名称必填」
  - 部门不存在 → 404 `NOT_FOUND`「部门不存在」
  - 上级是自身/子部门 → 400 `VALIDATION`「上级部门不能是自身或子部门」
  - 名称重复 → 400 `VALIDATION`「部门名称已存在」
  - 上级/主管不存在 → 400 `VALIDATION`「上级部门或主管不存在」
  - 更新失败 → 500 `INTERNAL`「更新失败」
- 成功响应 200：`{ "department": { "id": <int64>, "name": "<name>" } }`
- 特殊行为：审计 `dept_update`（`旧名→新名 parent:旧→新 leader:旧→新`）。

## 4.4 DELETE /api/server/admin/departments/:id
- 鉴权：AdminSession+`dept:write`
- path：`id` (int64, required)
- 错误：
  - `id` 非法 → 400 `VALIDATION`「非法部门 ID」
  - 部门不存在 → 404 `NOT_FOUND`「部门不存在」
  - 有关联（成员/子部门/授权）→ 400 `VALIDATION`「部门仍有关联(成员/子部门/授权),请先转移或清理」
  - 保留部门（全员）→ 400 `VALIDATION`「保留部门不可删除」
  - 删除失败 → 500 `INTERNAL`「删除失败」
- 成功响应 200：`{ "ok": true }`
- 特殊行为：审计 `dept_delete`；URL 主资源不存在 → 404，依赖资源不存在 → 400。

---

# 5. balance（余额管理）

### `BalanceSettings`（月度发放配置）
| key | 类型 |
|---|---|
| `enabled` | bool（余额硬闸门开关） |
| `monthly_amount` | float（每人每月额度，元；`<=0`=不自动发放） |
| `monthly_mode` | string（`add` 累加 / `cover` 清零后重发） |

### `GrantRun`（一次发放执行结果）
| key | 类型 |
|---|---|
| `month` | string |
| `mode` | string |
| `amount` | float |
| `granted` | int64（本次实际入账人数） |
| `skipped` | int64（本月已有锚跳过人数） |
| `actor` | string |
| `cover_debt_users` | int64（cover 模式被抹平欠款人数） |
| `cover_debt_amount` | float（cover 模式被抹平欠款额） |

### `BalanceGrant`（发放批次台账）
| key | 类型 |
|---|---|
| `month` | string |
| `mode` | string |
| `amount` | float |
| `affected` | int64 |
| `actor` | string |
| `created_at` | string(RFC3339) |

### `GrantStatus`（当月发放状态）
| key | 类型 |
|---|---|
| `month` | string |
| `eligible` | int64（符合条件启用普通员工） |
| `granted` | int64（本月已发放人数） |
| `pending` | int64（本月未发放人数） |
| `activated` | int64（已开通余额账户人数） |
| `last_grant` | BalanceGrant（nullable） |

### `BalanceLedgerEntry`（余额流水）
| key | 类型 |
|---|---|
| `id` | int64 |
| `user_id` | int64 |
| `kind` | string（consume/refund/reset/… 待确认完整枚举） |
| `amount` | float |
| `balance_after` | float |
| `reason` | string |
| `actor` | string |
| `usage_id` | int64（nullable） |
| `month` | string |
| `created_at` | string(RFC3339) |

## 5.1 POST /api/server/admin/users/:id/balance
- 鉴权：AdminSession+`user:write`
- path：`id` (int64, required)
- 请求体：
  - `mode` (string, optional, 默认 `add`)：`add`|`deduct`|`set`|`clear`
  - `amount` (float, **指针**；除 `clear` 外必填；缺失/null → 400)
  - `reason` (string, optional，≤200 字)
- 错误：
  - `id` 非法 → 400 `VALIDATION`「非法用户 ID」
  - 请求体格式错 → 400 `VALIDATION`「请求体格式错误」
  - 用户不存在 → 404 `NOT_FOUND`「用户不存在」
  - `reason` >200 字 → 400 `VALIDATION`「备注最多 200 字」
  - `mode` 非法 → 400 `VALIDATION`「mode 只能是 add/deduct/set/clear」
  - 除 `clear` 外 `amount` 缺失 → 400 `VALIDATION`「缺少 amount:若要清零请用 mode=clear,set 必须显式给出金额(0 也合法)」
  - `amount` 非有限数 → 400 `VALIDATION`「金额必须是有限数值」
  - `amount` >1 亿 → 400 `VALIDATION`「金额不能超过 1 亿元」
  - `add`/`deduct` 时 `amount<=0` → 400 `VALIDATION`「金额必须大于 0」
  - `set` 时 `amount<0` → 400 `VALIDATION`「金额不能为负数」
  - `deduct` 超当前余额 → 400 `VALIDATION`「扣减金额超过当前余额(如需归零请用「清零」)」
  - 事务/审计失败 → 500 `INTERNAL`「余额调整失败」
- 成功响应 200：`{ "ok": true, "user_id": <int64>, "balance_money": <float 分位> }`
- 特殊行为：「调整 + 审计」同一事务（`UsageWriteTx`），审计写失败整体回滚；`add/deduct` 走 `AdjustUserBalanceTx`（`deduct` 传负额），`set/clear` 走 `SetUserBalanceTx`；审计 `balance_adjust`。

## 5.2 GET /api/server/admin/users/:id/balance/ledger
- 鉴权：AdminSession+`user:read`
- path：`id` (int64, required)
- query：
  - `page` (int, optional, 默认 1)
  - `size` (int, optional, 默认 20, 最大 200)
  - `kind` (string, optional)——流水类型过滤
- 错误：`id` 非法 → 400 `VALIDATION`；用户不存在 → 404 `NOT_FOUND`；查询失败/对账读失败 → 500 `INTERNAL`
- 成功响应 200：
  ```json
  {
    "items": [ …BalanceLedgerEntry… ],
    "total": 0, "page": 1, "size": 20,
    "ledger_sum": 0.0,
    "balance_money": 0.0
  }
  ```
- 特殊行为：`ledger_sum` 应恒等于 `balance_money`（不变量 `users.balance_money == SUM(balance_ledger.amount)`）；两读任一失败即 500，不回落 0。

## 5.3 GET /api/server/admin/balance
- 鉴权：AdminSession+`user:read`
- 请求体：无
- 成功响应 200（`BalanceSummary` 直接序列化）：
  ```json
  {
    "settings": { "enabled": false, "monthly_amount": 0.0, "monthly_mode": "add" },
    "last_grant": null,
    "month_grant": null,
    "status": { "month": "2026-10", "eligible": 0, "granted": 0, "pending": 0, "activated": 0, "last_grant": null },
    "users": 0,
    "total_balance": 0.0,
    "overdrawn_users": 0,
    "overdrawn_debt": 0.0
  }
  ```
- 特殊行为：`users`/`total_balance` 统计 `status=1 AND role=user`；`overdrawn_*` 为余额 `<0` 的正数口径欠款汇总。

## 5.4 PUT /api/server/admin/balance
- 鉴权：AdminSession+`user:write`
- 请求体：
  - `enabled` (bool, required)
  - `monthly_amount` (float, required；0 ~ 1 亿)
  - `monthly_mode` (string, required；`add`|`cover`)
- 错误：
  - 请求体格式错 → 400 `VALIDATION`「请求体格式错误」
  - `monthly_amount` 越界 → 400 `VALIDATION`「月度额度必须在 0 ~ 1 亿元之间」
  - `monthly_mode` 非法 → 400 `VALIDATION`「发放模式只能是 add 或 cover」
  - 事务/审计失败 → 500 `INTERNAL`「保存失败」
- 成功响应 200：`{ "ok": true, "settings": { …BalanceSettings… }, "auto_grant": <bool>, "run": <GrantRun|null> }`
- 特殊行为：设置三键 + 审计同一事务；提交后 `InvalidateSettings`；`monthly_amount>0` 时立即 `GrantMonthlyBalance` 补发本月（逐人·月幂等锚 `balance_grant_items(user_id, month)`）；`auto_grant=run.Granted>0`；审计 `balance_settings` / `balance_grant`。

## 5.5 POST /api/server/admin/balance/grant
- 鉴权：AdminSession+`user:write`
- 请求体：无（用已保存配置）
- 错误：
  - 月度额度 `<=0` → 400 `VALIDATION`「请先配置大于 0 的月度额度」
  - 发放失败 → 500 `INTERNAL`「发放失败」
- 成功响应 200：`{ "ok": true, "already": <bool>, "run": { …GrantRun… } }`
- 特殊行为：只给本月尚未领取的启用员工发放；`already=run.Granted==0`（反复点击不重复加钱）；审计 `balance_grant`。

---

# 6. usage 管理（`/api/server/admin/usage*`）

### `UsageAggregateRow`（聚合行）
| key | 类型 |
|---|---|
| `label` | string |
| `prompt_tokens` | int64 |
| `completion_tokens` | int64 |
| `requests` | int64 |
| `embed_requests` | int64 |
| `embed_tokens` | int64 |
| `cache_tokens` | int64 |
| `cost` | float（元） |

### `UsageRequestRow`（请求级明细）
| key | 类型 |
|---|---|
| `id` | int64 |
| `time` | string(RFC3339) |
| `user_id` | int64 |
| `username` | string |
| `model` | string |
| `kind` | string（`chat`/`completions`/`responses`/`embedding`/`search`） |
| `prompt_tokens` | int64 |
| `completion_tokens` | int64 |
| `cache_tokens` | int64 |
| `search_requests` | int64 |
| `cost` | float |
| `estimated` | bool |

## 6.1 GET /api/server/admin/usage
- 鉴权：AdminSession+`usage:read`
- query：
  - `from` (string `YYYY-MM-DD`, optional)
  - `to` (string `YYYY-MM-DD`, optional)
  - `group` (string, optional, 默认 `day`)：`day`|`week`|`month`|`model`|`user`|`dept`|`provider`
  - `username` (string, optional)
  - `dept` (string, optional)
  - `model` (string, optional)
  - `kind` (string, optional)
- 错误：
  - 日期格式错 → 400 `VALIDATION`（「from 日期格式错误(YYYY-MM-DD)」/「to …」）
  - `from>to` → 400 `VALIDATION`「起始日期不能晚于结束日期」
  - `group` 非法 → 400 `VALIDATION`「group 必须是 day|week|month|model|user|dept|provider」
  - 账本段无法兑现过滤条件 → 400 `VALIDATION`（透传错误文案）
  - 统计失败 → 500 `INTERNAL`「统计失败」
- 成功响应 200：`{ "rows": [ …UsageAggregateRow… ], "group": "<group>", "truncated": <bool> }`
- 特殊行为：缺省窗口近 90 天（`usageDefaultWindowDays`）；`group=provider` 底层按 model 聚合后 `RegroupByProvider` 归并；`group=user` 超 500 行截断并置 `truncated=true`；日期按北京日归一。

## 6.2 GET /api/server/admin/usage/overview
- 鉴权：AdminSession+`usage:read`
- query：`from`/`to`（同 §6.1）
- 错误：日期错误 → 400 `VALIDATION`；统计失败 → 500 `INTERNAL`「统计失败」
- 成功响应 200：
  ```json
  {
    "range": { "cost": 0.0, "tokens": 0.0, "requests": 0 },
    "month": { "cost": 0.0, "tokens": 0.0, "requests": 0 },
    "today": { "cost": 0.0, "tokens": 0.0, "requests": 0 },
    "trend": [ …UsageAggregateRow(day)… ],
    "top_models": [ …UsageAggregateRow(model，≤10)… ]
  }
  ```
- 特殊行为：`tokens`=`prompt_tokens+completion_tokens` 合计（float）；`top_models` 按 `cost` 降序、`label` 次级稳定排序取前 10。

## 6.3 GET /api/server/admin/usage/requests
- 鉴权：AdminSession+`usage:read`
- query：
  - `page` (int, optional, 默认 1)
  - `size` (int, optional, 默认 20, 最大 100)
  - `from`/`to` (string `YYYY-MM-DD`, optional；窗口 ≤90 天)
  - `username` (string, optional)
  - `model` (string, optional)
  - `kind` (string, optional)：实际接受 `chat`|`completions`|`responses`|`embedding`|`search`（错误文案仅写 `chat|embedding|search`，待确认文案陈旧）
- 错误：
  - 日期错误 → 400 `VALIDATION`
  - 窗口 >90 天 → 400 `VALIDATION`「查询窗口最长 90 天」
  - `kind` 非法 → 400 `VALIDATION`「kind 必须是 chat|embedding|search」
  - 查询失败 → 500 `INTERNAL`「查询失败」
- 成功响应 200：`{ "rows": [ …UsageRequestRow… ], "total": 0, "page": 1, "size": 20, "kind": "<kind 原样回显>" }`
- 特殊行为：`to` 扩展为次日 00:00（闭区间日界）；按 `id` 倒序；窗口上限 90 天。

---

# 7. auth config（`/api/server/admin/auth*`）

### LDAP 配置对象
| key | 类型 |
|---|---|
| `server_url` | string |
| `bind_dn` | string |
| `bind_password` | string（读返回 `"***"` 掩码；写 `"***"`=保持现值） |
| `base_dn` | string |
| `user_filter` | string |
| `user_attr` | string |
| `group_filter` | string |
| `group_attr` | string |

### OIDC / OpenID 配置对象
| key | 类型 |
|---|---|
| `issuer` | string |
| `client_id` | string |
| `client_secret` | string（读 `"***"`；写 `"***"`=保持现值） |
| `redirect_url` | string |

## 7.1 GET /api/server/admin/auth
- 鉴权：AdminSession+`auth:read`
- 请求体：无
- 成功响应 200：
  ```json
  {
    "auth": {
      "mode": "local",
      "enabled": "local",
      "hide_local": false,
      "min_password_length": 10,
      "ldap": { …LDAP 配置… },
      "oidc": { …OIDC 配置… },
      "openid": { …OpenID 配置… }
    }
  }
  ```
- 特殊行为：`bind_password`/`client_secret` 以 `"***"` 掩码返回；`min_password_length` 默认 10。

## 7.2 PUT /api/server/admin/auth
- 鉴权：AdminSession+`auth:write`
- 请求体（全 optional）：
  - `mode` (string, optional；`local`|`ldap`|`both`|`oidc`|`openid`)
  - `enabled` (string, optional；逗号分隔 `local,ldap,openid,oidc`；缺省按 `mode` 推导)
  - `hide_local` (*bool, optional)
  - `min_password_length` (*int, optional；8~64)
  - `ldap` (LDAP 配置对象, optional)
  - `oidc` (OIDC 配置对象, optional)
  - `openid` (OpenID 配置对象, optional)
- 错误：
  - 请求体错 → 400 `VALIDATION`「请求体错误」
  - `mode` 非法 → 400 `VALIDATION`「auth.mode 必须是 local|ldap|both|oidc|openid」
  - `enabled` 含非法项 → 400 `VALIDATION`「auth.enabled 只能包含 local|ldap|openid|oidc」
  - `enabled` 重复 → 400 `VALIDATION`「auth.enabled 不能重复」
  - `enabled` 空集合 → 400 `VALIDATION`「auth.enabled 至少需要一个提供方(local|ldap|openid|oidc)」
  - `min_password_length` 越界 → 400 `VALIDATION`「min_password_length 必须在 8~64 之间」
  - `redirect_url` 非 https/回环 → 400 `VALIDATION`「<prefix>.redirect_url 必须是 https(或 http 回环)」
  - `issuer` 校验失败 → 400 `VALIDATION`「<prefix>.issuer <原因>」
  - `ldap.server_url` 校验失败 → 400 `VALIDATION`「ldap.server_url <原因>」
  - 密钥加密失败 → 500 `INTERNAL`「密钥加密失败」
  - 保存失败 → 500 `INTERNAL`「保存失败」
  - 保存成功但新配置未生效 → 500 `INTERNAL`「认证配置已保存,但新配置未生效: <原因>」
- 成功响应 200：`{ "ok": true }`
- 特殊行为：密码类字段 `"***"`=保持现值、其余值（含空串）=覆盖；全部设置键同一事务落库；提交后 `InvalidateSettings` + `ReloadAuth` 立即重建 providers；写库前校验 issuer（SSRF）、LDAP 地址（禁明文 ldap://）、redirect_url（防 open redirect）；`ldap` 启用时异步 `SyncDirectoryOnce`；审计 `auth_config`（changed 键集合 + 可选 `apply_failed`）+ `ldap_sync`。

## 7.3 POST /api/server/admin/auth/test
- 鉴权：AdminSession+`auth:write`
- 请求体：
  - `type` (string, required)：`ldap`|`oidc`|`openid`
  - `ldap` (LDAP 配置对象, optional；`bind_password` 留空/`"***"` 时回读已保存密文并解密)
  - `oidc` (object, optional)：`issuer` (string)
- 错误：`type` 非法 → 400 `VALIDATION`「type 必须是 ldap|oidc|openid」
- 成功响应 200（逐项结果，失败仅报告该方式）：
  - LDAP 成功：`{ "ok": true, "message": "LDAP 连接成功", "users": <int>, "groups": <int>, "sample": [ … ] }`
  - LDAP 失败：`{ "ok": false, "message": "<脱敏文案>" }`
  - oidc/openid 成功：`{ "ok": true, "message": "<type> discovery 正常" }`
  - oidc/openid 失败：`{ "ok": false, "message": "<原因>" }`
- 特殊行为：LDAP 探针做 bind + 用户/组统计 + 前 5 样例；oidc/openid 拉 `/.well-known/openid-configuration`（SSRF 防护：连接期 IP 复检，≤5 跳，私网放行、链路本地/云 metadata 拦截）；不写配置。
