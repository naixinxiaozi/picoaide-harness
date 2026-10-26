# 服务端 & 管理端重写 —— 功能点清单（NestJS + Nuxt）

> 目标（对应原仓库 `server/` 与 `server/webadmin/`）：
> - 服务端重写：**NestJS + drizzle-orm**，代码放 `server_nestjs/`
> - 管理端重写：**Nuxt 4.6 + @nuxt/ui v4.12.0 + @sidebase/nuxt-auth**，代码放 `server_nestjs_web/`
>
> 本清单只整理功能点，**不实现**；忽略 docker 文件，不采用 docker 部署。
> 依据：`server/AGENTS.md`（第一性原理 + 工程原则）、`server/internal/router/router.go`（API 唯一真源）、
> `server/docs/01-architecture.md` / `03-api-reference.md`、`server/internal/serverstore/migrations-pg/`（0001–0072 + 0075–0085）、
> `server/webadmin/src/`（141 个源文件，路由/导航/rbac 唯一真源）。

---

## 〇、技术栈映射（重写时的等价替换）

| 原实现（Go） | 重写目标（Node/NestJS） | 说明 |
| --- | --- | --- |
| gin + `internal/router.Register` | NestJS `@Controller` + `@Module`（按业务域拆模块） | 路由集中声明改由模块化 Controller 承担 |
| `serverauth.AdminAuth/BearerAuth` + RBAC | NestJS `@Guard` + 自定义 `@Permissions()` 装饰器 | 会话+CSRF、Bearer、RBAC 三种守卫 |
| `serverstore`（pgx/v5 手写 SQL） | drizzle-orm schema + repository 层 | PostgreSQL 唯一，无 SQLite |
| `migrations-pg/*.sql`（0001–0085） | drizzle-kit 迁移（重新表达 78 个迁移的表结构） | 0073/0074 为 DROP 语义，不重建 |
| argon2id 密码 | `@node-rs/argon2`（或等价 argon2 库） | 哈希口径需与原库兼容/迁移方案待定 |
| AES-GCM 凭证加密（master key） | Node `crypto` AES-256-GCM | 保留 `enc:v1:` 前缀与 master key 文件读取 |
| go-ldap/v3 | `ldapts` / `ldapjs` | LDAP 登录 + 全量同步组 |
| coreos/go-oidc/v3 | `openid-client` | OIDC 登录 |
| gin SSE（`c.SSEvent`） | NestJS `@Sse()` / raw `res` 流 | 报表测试、某些流式端点 |
| 编译期 build-tag 可选模块（skills/apps/connectors） | NestJS 动态模块 + 特性开关（`FEATURE_*` 环境变量） | P3 编译期变体改为运行时开关 |
| webadmin shadcn SPA（go:embed 内嵌） | 独立 Nuxt 应用，构建产物由服务端静态托管（或独立部署） | 不再 go:embed |
| React Router + ROUTE_REGISTRY 对拍 | Nuxt `pages/` 文件路由 + `definePageMeta` 权限 | 路由/导航/rbac 三张表迁移 |
| VChart | 保留 VChart 或换 `@nuxt/ui` + 图表库 | 用量/报表图表 |

---

## 一、服务端功能点（`server_nestjs/`）

### 1. 基础设施 / 横切
- 配置加载：`-addr/-data/-db-driver/-pg-dsn/--bootstrap-admin` 等启动参数 → NestJS `ConfigModule`（环境变量为主）。
- PostgreSQL 连接（drizzle-orm，PostgreSQL 唯一）。
- 数据库迁移执行器：drizzle-kit 迁移，带等锁预算、checksum 校验、`migrate:` 日志（对齐 R27-FIX39 语义）。
- 全局错误信封 `{"error":{"code","message"}}`：统一 `ExceptionFilter`，404/panic 也 JSON。
- 请求体大小限制（1MB 默认 + 大包路由豁免：归档 24MB / shared-skills·agent-presets 24MB / WASM validate·releases 48MB / uploads 分片 8MB / wasm request 1.4MB）。
- 全局校验（DTO + class-validator / zod）。
- 健康探针 `/healthz`（JSON）。
- 日志与结构化日志。

### 2. 认证 —— 客户端/员工面（`/api/client/v2/auth`）
- `POST /auth/login`（local / LDAP / OIDC 三种，返回 Bearer token）。
- `GET /auth/methods`（公开，登录方式清单）。
- `GET /auth/{oidc,openid}/login`、`GET /auth/{oidc,openid}/callback`（浏览器 OIDC 流程，固定两条）。
- `POST /auth/logout`、`GET /auth/me`、`POST /auth/password`（改密，需二次确认/当前密码）。
- `GET /auth/usage`（账户卡数据源，字段契约见 §三）。
- API token：签发/校验/90 天过期/只存哈希/改密·降权·禁用自动吊销。
- 密码强制修改（`PASSWORD_CHANGE_REQUIRED`）。
- 外部身份绑定（`users.external_identity`，0067）。

### 3. 认证 —— 管理面（`/api/server/admin`）
- 会话 + CSRF（`admin_sessions` 表，`secret_hash` 0066）。
- `POST /admin/login`、`POST /admin/login/mfa`、`GET /admin/auth/methods`。
- `GET/POST /admin/me/mfa`（enable/verify/disable），第二因子双验移除（`MFA_ALREADY_ENABLED` 409）。
- RBAC 角色（0046），权限点：UserRead/Write、DeptRead/Write、UsageRead、ServerInfoRead、AuditRead/Retention、AuthRead/Write、GatewayRead/Write、CapabilityRead/Write、ReportRead/Write、PortalRead/Write、MarketRead/Write、ConnectorRead/Write。
- `GET /admin/me`、`POST /admin/me/logout`、`POST /admin/me/password`。

### 4. 用户管理（`/admin/users`）
- CRUD：`GET`（分页/搜索）、`POST`、`PUT :id`、`DELETE :id`（**删除=抹除**：同事务清 api_tokens/usage 明细/usage_daily/usage_monthly/balance_ledger/balance_grant_items/admin_sessions/组归属/用户级授权，抹除金额入审计 `user_delete`）。
- `PUT :id/mfa`（管理员重置用户 MFA）、`GET :id/groups`、`PUT :id/department`（多部门 `group_ids`）、`GET :id/tokens`、`POST /tokens/:id/revoke`。
- 用户级授权（share_grants，授权对象=用户或部门组）。

### 5. 部门/组管理（`/admin/departments`）
- CRUD（parent_id/leader_id 金字塔，任意层级，主管）。
- 保留「全员」组（禁建/删/改名）；部门改名级联授权表；删除须无成员/子部门/授权引用。
- 权限继承 `UserEffectiveGroups` = 归属部门 + 祖先链 + 主管部门子树 + 隐式全员组。
- LDAP 登录全量同步组（空组即回收）。

### 6. 计量计费 / 余额
- **费用口径**（记录时结算）：未命中输入×input_price/1e6 + 命中输入×cache_input_price_per_1m/1e6 + 输出×output_price/1e6；峰谷窗口外×offpeak_discount；web_search 按次另加 search_price_per_1k/1000（不参与峰谷）。
- **usage 账**：`usage` + 分区/日账 `usage_daily`/月账 `usage_monthly` + `usage.estimated`(0063) + `usage.provider_id`(0065) + `usage.app_id`(0076) + `usage.search_requests`(0085)。
- **员工余额（唯一额度）**：`users.balance_money`（存量）+ `balance_ledger` 追加流水（不变量 `balance_money == SUM(amount)`）+ `balance_grant_items(user_id, month)` 逐人·月幂等锚。
  - 开通语义（首笔入账置 `balance_activated_at`）；消费始终扣（与 usage 同事务，差额结算/回补/refund）。
  - 管理端点：`POST /admin/users/:id/balance`（add/deduct/set/clear）、`GET /admin/users/:id/balance/ledger`、`GET/PUT /admin/balance`（enabled/monthly_amount/monthly_mode=add|cover）、`POST /admin/balance/grant`（补发本月，逐人幂等）。
- **余额闸门（三层，转发之前）**：学到下限 / 未定价模型 `MODEL_NOT_PRICED`（unpriced_model_policy=reject|allow）/ 最小计费额；耗尽 `429 BALANCE_EXHAUSTED`（admin 豁免，fail-closed）。
- 已下线保留（不读写）：员工 token 配额、金额配额、部门预算（列与 settings 键保留）。

### 7. 用量中心（`/admin/usage`）
- `GET /admin/usage`、`GET /admin/usage/overview`、`GET /admin/usage/requests`。
- 用量聚合：概览 / 部门 / 成员（含被删用户账本切换读源、无幽灵行）/ 模型 / 日志 / 余额 / 报表。

### 8. AI 网关（`/v1/*`，独立命名空间）
- `POST /v1/chat/completions | embeddings | messages | completions | responses`；根级无 `/v1` 变体同组（`POST /messages` 等）。
- `GET /v1/models`。
- Files API：`POST/GET /v1/files`、`GET/DELETE /v1/files/:file_id`（聊天引用 file_id 归属校验，非法 JSON 400 fail-closed）。
- BearerAuth + InFlightGuard（在飞请求体字节预算，缺省 128MiB，打满 503）。
- per-user 限流（缺省 0=不限制）。
- 出站体注入官方用户标识（chat `user_id`/responses `user`/anthropic `metadata.user_id`）。
- 读请求体预算 1h / 64MiB。
- 已知未实现（不重写）：`/beta`、`/anthropic/v1/*`、`GET /user/balance`。

### 9. 网关文件台账（Files API 归属）
- `gateway_files` 表（0077）+ `size_bytes`(0078) + `reaping_at`(0079) + `reap_gen`(0081)。
- 管理端：`GET /admin/gateway/files`、`GET /admin/gateway/files/summary`、`DELETE /admin/gateway/files/:file_id`、`POST /admin/gateway/files/purge`。
- 文件保留上限 `gateway.file_expiry_days`（缺省 7 天，上传时重写 `expires_after`），回收器在上游删除。

### 10. 上游 Provider / 模型管理（`/admin/providers`、`/admin/models`）
- providers CRUD + `GET :id/balance` + `POST :id/sync` + `POST /admin/providers/sync-all`。
- models CRUD；`model_concurrency_stats`(0049)；`models.catalog_missing`(0080)；`input_modalities`(0058)。
- provider protocol（0043/0044：OpenAI / Anthropic / 双协议）。
- 凭证 AES-GCM 加密存储（密钥不出服务端）。

### 11. 技能商城（marketplace / skills）
- 员工面：`/api/client/v2/marketplace/skills`（List/Get/DownloadArchive）。
- 管理面：skills CRUD + archive + enable + preview + file + normalize + grants（审核+授权双门制）。
- `skill_display_name`(0051)；归档统计(0040)；`drop_skill_git_mode`(0052)。
- 审核授权：未授权 404 不泄露存在性，授权对象=用户或部门组，admin 恒全量。

### 12. 共享技能（shared-skills）
- 员工面：`/api/client/v2/shared-skills`（ListVisible/Upload/Download）。
- 管理面：审核（approve/reject/remove）+ quality(0037) + file + grants + enabled + capability-locks。
- 多版本(0034)。

### 13. 共享 Agent（agent-presets）
- 员工面：`/api/client/v2/agent-presets`（ListVisible/Upload/Download/DownloadVersioned）。
- 管理面：审核（多版本 0035）+ quality + file + grants + enabled。
- `agent_preset_reason`(0033)、归档(0041)。

### 14. 能力中心（capabilities）
- 员工面：`/api/client/v2/capabilities`（ListCapabilities）。
- 管理面：`/admin/capabilities/approvals`（+ capability-locks 0050）。
- 能力锁定面板（capability-lock-panel）。

### 15. 内置技能（skillseed）
- 员工面 `skills/builtin`（ListBuiltin/archive）；管理面 seed/管理内置技能。

### 16. 连接器（connectors）
- 管理面：`/admin/connectors` List/Get/Create/Update/Remove/SetEnabled。
- 员工面不直接调：经 `bootstrap` 的 `connectors[]` 下发 + 客户端本地代理。
- 表 `connectors`(0042)；auth_mode 新增 `auto`(0083)；默认 MCP 连接器端点自述授权(0084)。

### 17. WASM 应用平台（apps）
- 员工面 `/api/client/v2/apps/wasm`：validate、`:app_id/releases`、publish/unpublish、freeze、export、diagnostics、schema、rows、availability、catalog、request、proof、open、uploads 分片 CRUD。
- 管理面 `/api/server/admin/wasm-apps`：AdminList、unpublish/publish/owner/freeze/review、releases approve/reject、limits GET/PUT、diagnostics/schema/rows/runtime、opens、opens/summary、ai-usage。
- 访问控制：`proof` 机制（Ed25519）、`X-Pico-Client-Budget-Ms`、错误码分层（外层 HTTP / 内层信封 status）。
- 表：`wasm_apps`(0069)、`wasm_app_access`(0071)、`wasm_call_events`(0072)、`wasm_app_opens`(+daily,0075)、`app_releases`(0053/0054)、`apps.official`(0059)。
- `wasm_appid_segments.go` 的 app_id 保留字（`{uploads}`）逻辑需等价移植。

### 18. 审计日志（`/admin/audit`）
- `GET /admin/audit`（page/size/action/username 过滤，默认保留 180 天，`audit.retention_days` 1~3650）。
- 哈希链防篡改（0048）+ 保留策略调度器（启动先跑 → 每 6 小时 → 随 ctx 退出，`PUT /admin/audit/settings` 保存时额外触发）。
- 敏感操作留痕（用户/部门/技能/授权变更/改密/降权/禁用/余额调整/删除抹除等）。

### 19. 报表订阅（`/admin/report-subscriptions`）
- CRUD + test；月报/日报；重试退避 `pending_period`/`fail_streak`/`next_attempt_at`(0082)。

### 20. 遥测（telemetry）
- `POST /api/client/v2/telemetry/skill-call`、`POST /api/client/v2/telemetry/error-reporting`（Bearer）。
- 客户端错误上报状态 `client_error_reporting_status`(0068)；`POST /admin/gateway/error-reporting/test`、`GET /admin/clients`。

### 21. 渠道内容（channel）
- `GET /api/client/v2/channel`、`/channel/logo|logo-dark|favicon`（公开）。
- 对外文案/标识只走渠道配置（`internal/channel`），**不提供在线编辑接口**。

### 22. 门户（portal）
- 门户首页 `/portal`（HTML）；`GET/PUT /admin/portal`（门户配置）。

### 23. 客户端安装包下发（clientrelease）
- `GET/HEAD /updates/client/*file`（安装包）；`GET /api/client/v2/updates/manifest`。
- `apps/:kind/:app_id/owner`（PUT，归属转移 Appstore）。

### 24. 服务器信息 / 并发 / 错误监控
- `GET /admin/server-info`（服务器状态、被拒请求计数与最近一条形状）。
- `GET /admin/concurrency`（模型并发）。
- 错误监控（GlitchTip 已下架，0055/0045 → 客户端错误上报改用自建状态）。

### 25. 后台定时调度器（background jobs）
- 审计保留清理（每 6 小时）。
- 月度余额发放（每 10 分钟，逐人·月幂等锚）。
- 网关文件回收器（`gateway.file_expiry_days` 上游删除）。
- 报表订阅发送。
- （如需）用量聚合滚动。

---

## 二、管理端功能点（`server_nestjs_web/`）

### 1. 认证与外壳
- 登录页（session 登录 + MFA 二次验证）。
- `@sidebase/nuxt-auth` 接管会话/CSRF/RBAC。
- 布局：侧栏三分区（**管理 / 运维 / 审计**）+ 顶栏 + 内容区。
- `landingPath` 逻辑（auditor→/audit，否则第一个可见条目）。
- 权限过滤 `visibleNav`（按服务端 permissions，未声明 perms 的条目 fail-closed 仅超管）。

### 2. 页面清单（迁移到 Nuxt `pages/`）
**管理区**
- `/users`（用户列表/搜索/新建/编辑/删除/MFA/令牌/部门归属/余额）。
- `/departments`（部门树 CRUD）。
- `/auth`（认证配置：local/LDAP/OIDC + `POST /auth/test`）。

**运维区**
- `/gateway`（网关配置 GET/PUT）。
- `/gateway-files`（网关文件台账）。
- `/error-monitoring`（错误监控/客户端上报）。
- `/usage`（用量中心：`overview` 概览 / `depts` 部门 / `members` 成员 / `members/:username` 成员详情 / `models` 模型 / `logs` 日志 / `balance` 余额 / `reports` 报表）。

**审计区**
- `/audit`（审计日志）。
- `/server-info`（服务器信息）。

**特性区（FEATURE_NAV_ENTRIES，P3 编译期变体 → 运行时开关）**
- `/capabilities`（能力中心：market 商城 tab / 能力锁定 / 审批）。
- `/app-center`（WASM 应用中心：`apps` 列表 / `opens` 打开统计 / `limits` 限额 + `app-platform` 迁移到 `/app-center/limits`）。
- `/connectors`（连接器管理）。
- 相关子页：`/marketplace`（→ `/capabilities?tab=market`）、`/app-center/opens`、`/app-center/limits`。

### 3. 公共 UI 与组件
- 全部 UI 组件来自 `@nuxt/ui`（badge/button/card/checkbox/dialog/input/select/switch/table/tabs/textarea 等），**禁止自写 UI 组件**。
- 业务组件：archive-preview-dialog、capability-lock-panel、grant-dialog、mfa-settings-dialog、password-dialog、secret-input、transfer-owner-dialog、user-search-select、page-header、empty-state、chart-lazy。
- 图表（用量/报表）保留 VChart 或替换为 Nuxt 生态图表方案。

### 4. 横切能力（lib/）
- `api.ts` + `api-error` + `api-paths`（统一 API 客户端、错误信封处理、路径登记）。
- `rbac.ts`（权限点唯一真源，迁移为 `definePageMeta`/middleware）。
- `routes.ts` / `nav.ts`（路由登记表 + 导航，迁移到 Nuxt 文件路由 + 组合式 nav）。
- `features.ts`（特性开关，替换 build-tag 变体）。
- `audit-sinks`、`capability-endpoints`、`channel`、`clipboard`、`csv`、`dsn`、`format`、`use-flash`、`router-future` 等工具函数。

---

## 三、跨端契约（两端必须一致，重写时逐条对齐）

1. **API 命名空间**：`/api/server/*`（管理面）、`/api/client/v2/*`（员工面）、`/v1/*`（LLM 网关独立）。禁止旧前缀 `/api/*`、`/v1/*`、`/v2/api/*`、`/v2/v1/*`。
2. **错误信封**：`{"error":{"code","message"}}`；错误码 AUTH_REQUIRED/AUTH_FAILED/FORBIDDEN/NOT_FOUND/VALIDATION/UPSTREAM/RATE_LIMITED/INTERNAL/PASSWORD_CHANGE_REQUIRED/BALANCE_EXHAUSTED/APPROVED_NOT_REJECTABLE/APP_DELISTED/MODEL_NOT_PRICED。
3. **bootstrap 契约**：`GET /api/client/v2/config/bootstrap` → `{default_model, models, skills, web, connectors}`（skills/web 缺省兜底）。
4. **员工用量契约**：`GET /api/client/v2/auth/usage` → `{balance_money, balance_activated, balance_enabled, balance_monthly, balance_mode, is_admin, today/yesterday/monthly/total usage+cost}`（跨语言契约，两端对拍）。
5. **审计契约**：`GET /api/server/admin/audit?page=&size=&action=&username=`。
6. **DB schema**：drizzle schema 需覆盖 0001–0072 + 0075–0085 全部表与约束（含哈希链、余额账本不变量、NOCASE 唯一等）。

---

## 四、待确认决策点（重写前需拍板）

1. **部署形态**：服务端（NestJS）与 Nuxt 管理端如何组合？单进程静态托管 vs 独立前后端（用户已明确不用 docker）。
2. **密码哈希兼容**：argon2id 哈希与 AES-GCM 加密的旧数据是否需兼容（决定迁移策略）。
3. **可选模块开关**：skills/apps/connectors 三模块从编译期 build-tag 改为运行时特性开关的具体形态（环境变量 `FEATURE_SKILLS/APPS/CONNECTORS`？）。
4. **图表库**：保留 VChart 还是替换。
5. **SSE/流式**：报表测试、网关流式响应在 NestJS 的具体实现方式。
6. **master key 文件**：AES-GCM 密钥的加载与管理方式在 Node 侧的等价实现。
7. **drizzle 迁移**：是否以「空库 + drizzle-kit 生成迁移」重述 78 个迁移，还是保留原有 SQL 仅建 drizzle schema 映射。
