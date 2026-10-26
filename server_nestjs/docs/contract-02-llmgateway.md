# LLM 网关 + 上游 Provider + 模型 + 网关文件 + 并发 — HTTP API 契约

> 源码唯一真源：`server/internal/llmgateway/`（非测试 .go）+ `server/internal/router/router.go`（路由）+ `server/internal/serverauth/rbac.go`（权限点）、`server/internal/serverauth/sysinfo.go`（server-info）、`server/internal/serverstore/gateway.go`、`server/internal/serverstore/gateway_files.go`。
> 错误信封统一 `{"error":{"code","message"}}`（`serverauth.WriteError`）；成功一律 `c.JSON`。SSE 为 `text/event-stream` 例外。

---

## 0. 命名空间与鉴权总览

| 命名空间 | 前缀 | 鉴权中间件 | 说明 |
|---|---|---|---|
| 员工网关 | `/v1/*` | `serverauth.BearerAuth` + `llmgateway.InFlightGuard` | OpenAI/Anthropic 兼容代理 |
| 员工网关（根级） | `/*`（无 `/v1`） | 同上 | 官方原生无 `/v1` 变体，含 `POST /messages` 兜底 |
| 管理面 | `/api/server/admin/*` | `serverauth.AdminAuth`（session+CSRF）+ `AdminRoute` 权限点 | webadmin 调 |

**权限点全名**（`server/internal/serverauth/rbac.go`）：
- `PermGatewayRead = "gateway:read"` — 网关/模型/渠道/价格读取
- `PermGatewayWrite = "gateway:write"` — 网关/模型/渠道/价格写入
- `PermServerInfoRead = "server-info:read"` — 服务器信息（含错误监控配置面）

**限体**：`/api/server`、`/api/client/v2` 两命名空间 `bodyLimitMiddleware` 默认 1MB（`1<<20`），网关相关路由无豁免。`/v1/*` 与根级网关**不挂** `bodyLimitMiddleware`，由各 handler 内部体积上限控制。

**费用口径**（`server/AGENTS.md §7`，写文档必备）：
```
cost = 未命中输入 × input_price/1e6
     + 命中输入  × cache_input_price_per_1m/1e6
     + 输出      × output_price/1e6
（高峰窗口 settings["usage.peak_windows"]（北京时间）外 × offpeak_discount）
web_search 另加：search_requests × settings["usage.search_price_per_1k"]/1000（不参与峰谷）
```

**余额三层闸门**（准入侧，唯一实现 `balance_gate.go`，在转发之前）：学到下限 / 未定价 `MODEL_NOT_PRICED` / 最小计费额，命中即 429 `BALANCE_EXHAUSTED`（或 `MODEL_NOT_PRICED` / `MODEL_ROUTING_UNAVAILABLE`），不转发上游。

---

## 1. /v1 网关代理（员工面）

> 每个端点同时注册在 `/v1/<path>` 与根级 `/<path>` 两个分组（`router.go registerGatewayV1`），handler 与契约完全一致；根级额外含 `POST /messages`（官方无 `/v1` 的 Anthropic 变体）。鉴权均为 `BearerToken`（`serverauth.BearerAuth`），并发经 `InFlightGuard`（每用户 32 在飞，超限 429 `RATE_LIMITED`「并发请求过多,请稍后再试」，env `PICOAI_GATEWAY_MAX_INFLIGHT_PER_USER` 可覆盖，须>0）。
> 注意：`/anthropic` 前缀、`x-api-key` 认证、`/beta`、`GET /user/balance` 均**未实现**。

### 1.1 `POST /v1/chat/completions`（及 `POST /chat/completions`）

- **鉴权**：BearerToken。
- **请求体**：OpenAI chat completions JSON。handler 仅要求顶层 `model`（string，缺→400 `VALIDATION`「请求体缺少 model 字段」）。其余字段原样转发；`stream`（bool）决定流式。体积上限 `maxChatBody = 64<<20`（64 MiB）。
- **请求体加工**（`prepareOutboundBody` + 注入）：
  - 注入官方用户标识：顶层 `"user_id": "u<user.ID>"`（`identityOpenAI`；platformUserID 前缀 `u`）。
  - 校验每个 `file_id` 引用归属（`fileReferencesOwned`）：引用他人/未登记文件→404；超上限→400「单次请求引用的文件过多（上限 N 个）」；形状非法→400；DB 错误→500。
  - `sanitizeOutboundBody` 剔除 `dsh_` 私有字段。
  - 默认参数：`default_params.max_output` 注入 `max_tokens`（若客户端未传 `max_tokens`/`max_completion_tokens`）。
  - 流式：强制 `stream_options.include_usage = true`。
  - 渠道覆盖：provider `Channel` 非空时 `channels.Get` → `applyChannelOverrides`（deepMerge + removeKeys）。
- **转发**：`url = baseURL + "/v1/chat/completions"`（base 去尾斜杠，含 `/v1` 则直拼）；`Authorization: Bearer <APIKey>`。流式用 SSE client + `context.WithoutCancel`。≥500 触发 provider failover（按 `enabled=1` provider 列表顺序轮询）。
- **响应**：透传上游 JSON（非流式）；流式为 `text/event-stream`。`passHeaders` 白名单透传：`Content-Type`/`Retry-After`/`X-Request-Id`/`X-RateLimit-Limit`/`X-RateLimit-Remaining`。
- **费用**：billingKind `chat`。命中缓存 token 解析（见下）。
- **状态码/错误码**：
  - 401 `AUTH_REQUIRED`「未认证」；400 `VALIDATION`（缺 model / 请求体非法 JSON / file_id 超限）；429 `RATE_LIMITED`（限流/并发）；404 `NOT_FOUND`「模型不存在或不可用」；500 `INTERNAL`「模型路由查询失败」；502 `UPSTREAM`（上游不可用/超时/过大/读取失败）；503 `SERVER`（请求体加工并发满「网关繁忙（请求体加工并发已满），请稍后重试」）；503 `METERING_FAILED`；429 `BALANCE_EXHAUSTED` / `MODEL_NOT_PRICED` / `MODEL_ROUTING_UNAVAILABLE`（余额闸门）。
  - 上游非 2xx：`sanitizeUpstreamError` 收敛为 `{"error":{"code","message"}}`（只留 error.message/type/code，message 截 2000 字符；非 JSON→固定 `UPSTREAM_ERROR`「上游请求失败」）。

### 1.2 `POST /v1/embeddings`（及 `POST /embeddings`）

- **请求体**：`{model: string(required), input: string | []string(required)}`。体积上限 `maxEmbedBody = 4<<20`（4 MiB）。
- **转发**：`MatchModelsByProtocol(openai)` → 逐个 provider `POST {base}/v1/embeddings`；4xx 直接返回 err，5xx/传输错误继续下一家（failover）；校验 `len(Data)==len(texts)`、index 范围、维度一致。
- **响应**（200，固定形状，非上游透传）：
  ```json
  {"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1,...]}],"model":"...","usage":{"prompt_tokens":N,"total_tokens":N}}
  ```
  `usage.prompt_tokens`/`total_tokens` = 上游 `TotalTokens` 否则 `PromptTokens`，<=0 时估算（estimated=true）。
- **费用**：billingKind `embedding`（复用 input 价）。
- **错误**：502 `UPSTREAM`「上游服务不可用」。

### 1.3 `POST /v1/messages`（及 `POST /messages`）— Anthropic

- **请求体**：Anthropic messages JSON。handler 仅要求顶层 `model`（string，缺→400）。体积上限 `maxMessagesBody = 64<<20`。
- **请求体加工**：注入 `metadata.user_id`（`identityAnthropic`，platformUserID `u<id>`；`metadata` 非对象→400「metadata 必须是 JSON 对象」）。
- **转发**：`MatchModelsByProtocol(anthropic)`。URL：`anthropicBaseURL(base,protocol) + "/messages"`（protocol=both 且 base 无 `/anthropic` 时 = base+"/anthropic/v1"；protocol!=both 时 = base）。Header：`Content-Type: application/json`、`x-api-key: <APIKey>`、`authorization: Bearer <APIKey>`、`anthropic-version` 客户端携带则透传（不覆盖）。
- **费用**：billingKind `search`（`serveAnthropicJSON` 用 `RecordUsageKindCachedEstimatedForProviderWithSearch`，带 `searchRequests=countWebSearches(body)`）。anthropic usage 解析 `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens`（顶层 `usage` 或 `message.usage`）；总输入=clamp(input)+clamp(cache_read)+clamp(cache_creation)（satAddTokensNonNeg）；cache=cache_read。
- **流式**：`serveAnthropicStream`，收尾标记 `event:message_stop`。
- **错误**：同 1.1（404「模型不存在或不可用」/500「模型路由查询失败」）。

### 1.4 `POST /v1/completions`（及 `POST /completions`）— FIM

- **请求体**：OpenAI completions JSON。要求 `model` + `prompt`（均 required；缺 prompt→400「请求体缺少 prompt 字段」）。体积上限 `maxFIMBody = 64<<20`。**不注入** user_id（`identityNone`）。
- **转发**：`MatchModelsByProtocol(openai)` → `forwardEndpoint(...,"/completions")` = base+"/completions"。
- **费用**：billingKind `completions`。

### 1.5 `POST /v1/responses`（及 `POST /responses`）

- **请求体**：OpenAI responses JSON。要求 `model` + `input`（缺 input→400「请求体缺少 input 字段」，`req.Input==nil` 判定）。体积上限 `maxResponsesBody = 64<<20`。
- **请求体加工**：注入顶层 `"user": "u<id>"`（`identityResponses`）。
- **转发**：`MatchModelsByProtocol(openai)` → `forwardEndpoint(...,"/responses")`。
- **费用**：billingKind `responses`。
- **流式 usage**：`parseUsage` 兼容 `input_tokens`/`output_tokens`/`input_tokens_details.cached_tokens`（两套字段 chat 优先）。

### 1.6 `GET /v1/models`（及 `GET /models`）

- **请求体**：无。
- **响应**（200）：
  ```json
  {"models":[{"id":"...","display_name":"...","default_params":"...","input_modalities":["text"]}]}
  ```
  `Model` 字段：`id`、`display_name`（COALESCE(display_name,name)）、`default_params`（COALESCE(default_params,'')）、`input_modalities`（COALESCE(input_modalities,'["text"]')）。
- **过滤**：`SELECT m.name,... FROM models m JOIN gateway_providers p ON p.id=m.provider_id WHERE p.enabled=1 AND m.catalog_missing=FALSE ORDER BY m.id`。
- **错误**：500 `INTERNAL`「模型列表查询失败」。

### 1.7 Files API（员工侧，仅 DeepSeek 上游）

> `POST /v1/files`、`GET /v1/files`、`GET /v1/files/:file_id`、`DELETE /v1/files/:file_id`（及根级同路径）。鉴权 BearerToken。**仅 DeepSeek**：`fileUpstream` 只选 `balanceSupports(base,name)`（lower 含 "deepseek"）且 `Protocol∈{openai,both}` 的 provider，按 id 升序取第一个；无→503 `UPSTREAM`「未配置可用的 DeepSeek 上游(文件接口仅支持 DeepSeek)」。URL = base 去尾斜杠去尾 `/v1` 后拼 `/files`+suffix。HTTP client 不跟随重定向（`ErrUseLastResponse`）。

#### 1.7.1 `POST /v1/files`（及 `POST /files`）— 上传

- **请求体**：multipart/form-data（直通）。体积上限 `maxFilesUploadBody = 64<<20`（64 MiB，官方单文件上限）。
- **特殊行为**：`rewriteUploadExpiry` 重写 multipart 过期字段（`expires_after[anchor]`/`expires_after[seconds]` 或整对象 `expires_after`；anchor 恒 `created_at`；seconds=min(客户端值, `gateway.file_expiry_days` 上限，缺省 7 天)）；2xx 时 `recordUploadedFile` 登记台账（响应 `{id, expires_at, bytes, size_bytes}`）+ `PurgeExpiredGatewayFiles`。
- **错误**：413 `VALIDATION`「上传文件超过上限（单文件最大 NMiB）」；503 `SERVER`（请求体加工并发满/读超时）；503 `SERVER`「该文件正在被回收（重复内容命中了即将过期的对象），请重试或改用内联方式」；502 `UPSTREAM`（上游失败/过大/读取失败）。

#### 1.7.2 `GET /v1/files`（及 `GET /files`）— 列表

- **query**：原样透传（`?`+RawQuery）。
- **特殊行为**：2xx 时按 `ListGatewayFileIDs(userID)` 归属过滤 `filterFileList`（解析失败返回 `{"object":"list","data":[]}`；重算 `first_id`/`last_id`，空页删两字段 + `has_more=false`）。

#### 1.7.3 `GET /v1/files/:file_id` — 检索

- **path**：`file_id`（validGatewayFileID：非空、≤200、仅 `[a-zA-Z0-9_-]`；非法→404）。
- **特殊行为**：`GatewayFileOwnedByGeneration` 判归属（他人/未登记→404）；上游 404 时 `DeleteGatewayFileRowIfGeneration` 收敛。
- **404 文案**（`writeFileNotFound`）：`file_id not found or expired（文件不存在或已过期，请重新上传）[: <file_id>]`（必须含 ASCII "file"+"not found|expired"+id，官方客户端据此回落 base64）。

#### 1.7.4 `DELETE /v1/files/:file_id` — 删除

- **特殊行为**：归属校验（否→404）→ `ClaimGatewayFileForDeletion` 认领（`!claimed`→409 `FILE_BUSY`「该文件正在被清理,请稍后重试」）→ 上游 DELETE → 2xx/404 时 `FinishReapedGatewayFile` 收敛。

---

## 2. Providers（管理面 `/api/server/admin`）

> 鉴权：AdminSession + 权限点。读 = `gateway:read`，写 = `gateway:write`。api_key 以 AES-GCM 存储（`encryptSecret` 走 `util.GetMasterKey`），输出时脱敏为 `"***"`（`providerJSON`）。provider 创建/更新/删除、模型创建/更新/删除、gateway 配置、文件清理全部写 `audit_logs`（审计动作：`provider_create`/`provider_update`/`provider_delete`/`model_create`/`model_update`/`model_delete`/`gateway_config`/`gateway_file_delete`/`gateway_file_purge`/`error_reporting_test`）。

### 2.1 `GET /api/server/admin/providers`

- **响应**（200）：
  ```json
  {"providers":[{"id":1,"name":"...","base_url":"...","api_key":"***","models":["m1"],"enabled":true,"channel":"","protocol":"openai"}]}
  ```
  `api_key` 非空时恒 `"***"`；`protocol` 空时归一 `"openai"`；`enabled` = `Enabled==1`。
- **错误**：500 `INTERNAL`「查询失败」。

### 2.2 `POST /api/server/admin/providers`

- **请求体**：
  | 字段 | 类型 | required | 说明 |
  |---|---|---|---|
  | `name` | string | 是 | 唯一（重复→400 `VALIDATION`「上游名称已存在」） |
  | `base_url` | string | 是* | *channel 非空且 base_url 空时用渠道默认 BaseURL |
  | `api_key` | string | 条件 | channel 非空时必填；`"***"` 掩码→400 |
  | `models` | []string | 否 | 仅手动型（channel=""）落库；渠道型模型由同步维护 |
  | `channel` | *string | 否 | nil=不改；""=手动型；非空=指定渠道 |
  | `enabled` | *bool | 否 | false=禁用（不参与路由） |
  | `protocol` | *string | 否 | `openai`(默认)/`anthropic`/`both`；非法→400「protocol 仅支持 openai/anthropic/both」 |
- **校验**：`validateUpstreamBaseURL`（http/https、无 userinfo、非 metadata/链路本地、域名解析可失败放行）。`base_url` 失败→400 `VALIDATION`（具体错误文案）。
- **响应**（200）：`{"provider": {...providerJSON}, "sync": <SyncResult|null>}`（渠道型提交后立即同步，失败不回滚，落入 `sync.error`）。
- **特殊行为**：插入 + 手动型清单同步 + 审计同事务（`UsageWriteTx`）；渠道型出网同步在 Commit 后。审计 `provider_create`。
- **错误**：400（校验/名称重复）、500 `INTERNAL`（创建失败/模型同步失败/密钥加密失败）。

### 2.3 `PUT /api/server/admin/providers/:id`

- **path**：`id`（非数字→400「无效 ID」）。
- **请求体**：同 2.2，但全部字段**指针语义**（缺省/未传=不覆盖；`api_key` 空串=保持不变，`"***"`→400「api_key 是掩码值:要更换密钥请传新密钥,保持原密钥请省略该字段」；`channel` ""=清空为手动型；`models` 未传但 channel 非空→清空手动清单）。
- **特殊行为**：事务内 `SELECT ... FOR UPDATE` 行锁读基线（`GetGatewayProviderTx(tx,id,true)`）；字段级 diff 审计（`provider_update`），价格类字段（`price:<name>:<old>→<new>`）、`params:<name>`、`models_prices:<N>项变更`（明细最多 8 条）；渠道型切回手动型时清空旧渠道模型；提交后 `InvalidateModelConfig` + `InvalidateModelsChanged`，渠道型提交后立即同步。
- **响应**（200）：`{"provider": {...}, "sync": <SyncResult|null>}`。
- **错误**：400/404「上游不存在」/500（更新失败/模型同步失败/密钥加密失败）。

### 2.4 `DELETE /api/server/admin/providers/:id`

- **path**：`id`（非数字→400「无效 ID」）。
- **响应**（200）：`{"ok": true}`。
- **审计**：`provider_delete`（`<name> base_url=<redacted>`）。
- **错误**：404「上游不存在」（读或删都不存在）、500「删除失败」。

### 2.5 `GET /api/server/admin/providers/:id/balance`

- **path**：`id`（非数字→400「provider id 必须是数字」）。
- **响应**（200，三种形状）：
  - 不支持：`{"supported":false,"fetched_at":"<RFC3339>"}`（`balanceSupports` lower 含 "deepseek" 才支持）。
  - 抓取失败：`{"supported":true,"is_available":false,"infos":[],"error":"<err>","fetched_at":"<RFC3339>"}`。
  - 成功：`{"supported":true,"is_available":true,"infos":[{"currency":"...","total_balance":"...","granted_balance":"...","topped_up_balance":"..."}],"fetched_at":"<RFC3339>"}`。
- **实现**：`GET {base}/user/balance` Bearer key，解析 `{is_available, balance_infos[]}`；HTTP client Timeout=10s + 拒绝重定向。
- **错误**：404「provider 不存在」/500「查询失败」/500「上游密钥解密失败」。

### 2.6 `POST /api/server/admin/providers/:id/sync`

- **path**：`id`（非数字→400「无效 ID」）。
- **响应**（200）：`{"result": <SyncResult>}`。`SyncResult = {provider, added, removed, skipped?, error?}`（provider=name、added/removed=int、skipped=bool omitempty、error=string omitempty）。
- **错误**：404「上游不存在」/400「渠道不存在」/500「密钥解密失败」/500「查询失败」。

### 2.7 `POST /api/server/admin/providers/sync-all`

- **响应**（200）：`{"results": [<SyncResult>...]}`（每个 enabled provider 一条）。
- **错误**：500 `INTERNAL`「同步失败」。
- **特殊行为**：`SyncOnce` 逐 provider：`enabled!=1` 或 `APIKeyEnc==""` skip；`Channel==""`→`Skipped=true`+`Error`「手动型上游无需同步(模型来自模型列表)」；`channels.Get` 失败→"unknown channel"；15s HTTP 超时（`httpFetch15s`）；customBase 与渠道默认不同→GET customBase+"/models" 走 `ParseOAIModels`，否则 `ch.FetchModels`；`RemoveMissingProviderModels` 算 removed；`SyncIteration`=CleanupPendingUsage(6h)+SyncOnce。

### 2.8 `GET /api/server/admin/channels`

- **响应**（200）：`{"channels":[{"name":"...","base_url":"..."}]}`（`channels.All()` → `channels.Get`）。
- 无错误分支（恒 200）。

---

## 3. Models（管理面 `/api/server/admin`）

> 鉴权：AdminSession + `gateway:read`/`gateway:write`。管理端列表用完整字段（含价格/峰谷折扣），客户端 `/v1/models` 走公开 `ListModels`（基础字段，不泄露定价）。

### 3.1 `GET /api/server/admin/models`

- **响应**（200）：`{"models": [<Model>...]}`。`Model` 完整字段（JSON tag）：
  ```json
  {"id":1,"name":"...","provider_id":2,"display_name":"...","default_params":"...",
   "input_modalities":["text"],"input_price_per_1m":1.5,"output_price_per_1m":3.0,
   "cache_input_price_per_1m":0.75,"offpeak_discount":0.5,
   "provider_name":"...","provider_channel":"","provider_enabled":true,"catalog_missing":false}
  ```
  价格字段为 `*float64`，nil = 未定价（JSON null）；`input_modalities` 空/非法=仅 text；`default_params` 为字符串（JSON 文本）。
- **错误**：500 `INTERNAL`「查询失败」。

### 3.2 `POST /api/server/admin/models`

- **请求体**：
  | 字段 | 类型 | required | 说明 |
  |---|---|---|---|
  | `name` | string | 是 | 模型名（重复→400「模型名已存在」） |
  | `provider_id` | int64 | 是 | 必须存在（否则 400「所属上游不存在」） |
  | `display_name` | string | 否 | |
  | `default_params` | string | 否 | JSON 文本 |
  | `input_modalities` | []string | 否 | 缺省=仅 text；`{text,image}` 子集，无重复，空数组/非法→400 |
  | `input_price_per_1m` | *float64 | 否 | 负数→400「input_price_per_1m 不能为负数」 |
  | `output_price_per_1m` | *float64 | 否 | 负数→400 |
  | `cache_input_price_per_1m` | *float64 | 否 | 负数→400；null=清空 |
  | `offpeak_discount` | *float64 | 否 | 必须 (0,1]；否则 400「offpeak_discount 必须在 (0,1] 之间(1 = 无峰谷价)」 |
- **特殊行为**：渠道型 provider 先 `RemoveExcludedModelTx`（移出排除名单）；建行 + 移名单 + 审计同事务；审计 `model_create`。
- **响应**（200）：`{"model": <Model>}`。
- **错误**：400「模型名和 provider 必填」/400 价格/模态/「所属上游不存在」/400「模型名已存在」/500「创建失败」。

### 3.3 `PUT /api/server/admin/models/:id`

- **path**：`id`（非数字→400「无效 ID」）。
- **请求体**：同 3.2，但指针语义（缺省不覆盖）；`input_modalities` 显式数组（含空，校验拒绝）才覆盖；价格字段用 `optionalFloat` 区分「未传（Set=false，不覆盖）」与「显式 null（Set=true, Value=nil，清空为未定价）」。
- **改名防护**：`name` 非空且 != 原名时，有用量记录→400「该模型已有用量记录,不允许改名」；渠道同步模型→400「渠道同步模型由上游命名,不允许改名」。
- **特殊行为**：事务内 FOR UPDATE 读基线 + 更新 + 审计（`model_update`）；字段级 diff（name/provider/display/params/modalities/input/output/cache/offpeak）。
- **响应**（200）：`{"model": <Model>}`。
- **错误**：400（无效 ID/请求体错误/价格/模态/改名/所属上游不存在/模型名已存在）/404「模型不存在」/500「查询失败」「更新失败」。

### 3.4 `DELETE /api/server/admin/models/:id`

- **path**：`id`（非数字→400「无效 ID」）。
- **特殊行为**：渠道型 provider 删除其同步模型记入排除名单（`AddExcludedModelTx`，与删行同事务，防 SyncLoop 复活）；审计 `model_delete`。
- **响应**（200）：`{"ok": true}`。
- **错误**：404「模型不存在」/500「删除失败」。

---

## 4. Gateway Config（管理面 `/api/server/admin`）

> 鉴权：AdminSession + `gateway:read`（GET）/`gateway:write`（PUT）。

### 4.1 `GET /api/server/admin/gateway`

- **响应**（200）：
  ```json
  {
    "default_model":"",
    "rate_limit":"0",
    "peak_windows":"",
    "search_price_per_1k":"0",
    "retention_months":"6",
    "error_reporting_dsn":"",
    "error_reporting_enabled":false,
    "error_reporting_level":"",
    "error_reporting_heartbeat":false,
    "glitchtip_base_url":"",
    "glitchtip_organization":"",
    "default_thinking_level":"",
    "server_base_url":"",
    "max_file_refs":"600",
    "body_parse_budget_mb":"128",
    "file_expiry_days":"7",
    "unpriced_model_policy":"reject"
  }
  ```
  空值回落到缺省展示：`rate_limit` 缺省 "0"（不限）、`retention_months` 缺省 "6"、`max_file_refs` 缺省 "600"、`body_parse_budget_mb` 缺省 "128"、`file_expiry_days` 缺省 "7"、`search_price_per_1k` 缺省 "0"、`unpriced_model_policy` 经 `serverstore.UnpricedModelPolicy(db)`（fail-closed 回落 reject）。布尔字段 = settings=="true"。
- **错误**：500 `INTERNAL`「读取失败」。

### 4.2 `PUT /api/server/admin/gateway`

- **请求体**（全部指针语义，缺省不覆盖；`FlexibleString` 兼容 JSON string 或 number）：
  | 字段 | 类型 | 校验/语义 |
  |---|---|---|
  | `default_model` | *string | 必须属于已启用模型（否则 400「默认模型必须属于已启用的模型」） |
  | `rate_limit` | *FlexibleString | 0~100000 整数（0=不限制）；否则 400 |
  | `peak_windows` | *string | 空串=清空（无峰谷价）；非空经 `ValidatePeakWindows`（`weekdays:[]`/全非法→400） |
  | `search_price_per_1k` | *FlexibleString | 0~1000 数值（元/千次，0=不计费）；否则 400 |
  | `retention_months` | *string | 0~120 整数（0=永久）；否则 400「retention_months 必须是 0~120 的整数(0=永不删除)」 |
  | `error_reporting_dsn` | *string | `InspectErrorReportingDSN` 准入（硬拒 loopback/链路本地/云 metadata；私网与 http 只告警）；与库中逐字相同视为未提供 |
  | `error_reporting_enabled` | *bool | 与 dsn 跨字段一致：enabled=true 且 dsn 空（且本次显式提交其一）→400 |
  | `error_reporting_level` | *string | error\|warning\|info\|debug（否则 400「reporting_level 必须是 error|warning|info|debug」） |
  | `error_reporting_heartbeat` | *bool | 独立开关 |
  | `glitchtip_base_url` | *string | 无准入校验（审计写侧脱敏） |
  | `glitchtip_organization` | *string | |
  | `default_thinking_level` | *string | off\|low\|high\|max（否则 400） |
  | `server_base_url` | *string | 无准入校验（审计写侧脱敏） |
  | `max_file_refs` | *FlexibleString | 1~4096 整数；否则 400 |
  | `body_parse_budget_mb` | *FlexibleString | 64~8192 整数；否则 400 |
  | `file_expiry_days` | *FlexibleString | 1~30 整数；否则 400 |
  | `unpriced_model_policy` | *string | `reject`\|`allow`（否则 400「unpriced_model_policy 必须是 reject 或 allow」） |
- **特殊行为**：全部写库收进单一事务（`UsageWriteTx` + 逐键 `SetSettingTx`），审计 `gateway_config`（字段级变更，凭据型 URL 用 `redactURLCredentialForAudit` 折叠为 `scheme://host/…（已脱敏）`）；提交后 `InvalidateSettings()` + `InvalidateGatewayLimits()`；`retention_months` 显式提交时提交后执行破坏性 `CleanupUsageRetention`（失败→500「保留清理失败」）。
- **响应**（200）：`{"ok": true, "warnings": [<string>...]}`（风险配置透出告警条，如私网/明文 http DSN、启用上报但 DSN 空等）。
- **错误**：400（请求体错误/各字段校验）/500「保存失败」/500「保留清理失败」。

---

## 5. Gateway Files（管理面 `/api/server/admin`）

> 鉴权：AdminSession + `gateway:read`（GET）/`gateway:write`（DELETE/purge）。文件台账 `gateway_files` 表（迁移 0077/0078/0079/0081）。

### 5.1 `GET /api/server/admin/gateway/files`

- **query**：
  | 参数 | 类型 | 说明 |
  |---|---|---|
  | `user_id` | int | 正整数按员工过滤；非法→恒空集 |
  | `user` | string | 一律按用户名（数字 ID 走 user_id）；查不到→恒空集 |
  | `q` | string | 匹配 file_id 子串（大小写不敏感） |
  | `state` | string | `active`\|`expired`\|`all`（未知→400「state 只支持 active|expired|all」） |
  | `sort` | string | 白名单 `created_at`\|`expires_at`\|`size_bytes`\|`username`（缺省 created_at） |
  | `order` | string | `asc` 或非 asc=desc |
  | `page` | int | >1 才生效，上限 2^20 |
  | `size` | int | 1~200，缺省 50（超上限归一 50） |
- **响应**（200）：
  ```json
  {
    "rows":[{"file_id":"...","user_id":1,"username":"...","display_name":"...",
             "size_bytes":123,"created_at":"<RFC3339>","expires_at":"<RFC3339>|null","expired":false}],
    "total":42,
    "totals":{"files":100,"bytes":123456,"expired":5}
  }
  ```
- **错误**：400（state 非法）/500「读取文件台账失败」。

### 5.2 `GET /api/server/admin/gateway/files/summary`

- **query**：`sort`（同 5.1 白名单）、`order`（asc/desc）。
- **响应**（200）：
  ```json
  {
    "rows":[{"user_id":1,"username":"...","display_name":"...","files":10,"bytes":123,
             "expired_files":2,"earliest_expires_at":"<RFC3339>|null"}],
    "totals":{"files":100,"bytes":123456,"expired":5}
  }
  ```
- **错误**：500「读取占用汇总失败」。

### 5.3 `DELETE /api/server/admin/gateway/files/:file_id`

- **path**：`file_id`（validGatewayFileID 校验；非法→404）。
- **特殊行为**：`GatewayFileRowExists` 判存在（不存在→404）；`fileUpstream` 无→503 `SERVER`「没有可用的文件上游」；`deleteGatewayFileFenced`（认领→复检→上游 DELETE→世代收尾，与回收器同一套 fence）。
- **响应**（200）：`{"ok": true, "deleted": 1}`。
- **审计**：`gateway_file_delete`（`file_id=<id>`）。
- **错误**：404（不存在）/503（无上游）/409 `FILE_BUSY`「该文件正在被回收或已被重新登记,本次未执行删除;请刷新列表后重试」/409 `FILE_RECLAIMED`「上游对象已删除,但台账行在删除期间归了新的上传者,已保留该行」/502 `UPSTREAM`「上游删除失败，请稍后重试」/500「读取文件台账失败」。

### 5.4 `POST /api/server/admin/gateway/files/purge`

- **请求体**：
  | 字段 | 类型 | 说明 |
  |---|---|---|
  | `user` | *string | 一律用户名（数字用户名不会被当 ID）；不存在→400「user 必须是存在的用户名（数字 ID 请用 user_id）」 |
  | `user_id` | *int64 | 必须正整数（<=0→400「user_id 必须是正整数（用户名请用 user）」） |
  | `state` | *string | `active`\|`expired`\|`all`（未知→400） |
  | `expired_only` | *bool | true = 等价 state=expired（优先级更高） |
  | `limit` | *int | 单次上限 500（<=0 或 >500 → 500） |
- **安全边界**：`user` 或 `state` **至少给一个**（否则 400「必须指定 user 或 state（避免误清全量台账）」）；删**有效**文件必须指名员工（`state=active` 且无 user→400「清理仍然有效的文件必须指定员工（user 或 user_id）；全组织范围只允许清理已过期文件」）。
- **响应**（200）：`{"ok": true, "deleted": N, "skipped": N, "failed": N, "matched": N}`。
- **审计**：`gateway_file_purge`（`<target> 删除 N 跳过 N 失败 N 命中 N`）。
- **错误**：400（各校验）/500「读取待清理文件失败」/503「没有可用的文件上游」。

### 5.5 `POST /api/server/admin/gateway/error-reporting/test`

- **请求体**：`{"dsn": "<可选 string>"}`（dsn 省略=用已保存 DSN；显式空串→400「dsn 不能为空(省略该字段才会使用已保存的 DSN)」）。
- **特殊行为**：服务端代发 Sentry 测试事件（8s 超时、X-Sentry-Auth 头、随机 32 hex event_id）；`InspectErrorReportingDSN` 拒绝→400。
- **响应**：
  - 成功（200）：`{"ok":true,"event_id":"...","http_status":200,"endpoint":"...","elapsed_ms":N,"note":"本结果由服务端发起,证明服务端到上报地址可达;员工客户端的网络环境可能不同"}`。
  - 失败（502）：`{"error":{"code":"UPSTREAM","message":"..."},"detail":{"kind":"<DNS|CONNECT|TLS|TIMEOUT|BLOCKED|HTTP_3XX|HTTP_4XX|HTTP_5XX|CANCELED|UNKNOWN>","endpoint":"...","note":"...","http_status":N,"elapsed_ms":N}}`。
- **错误**：400「请求体格式错误(需要 JSON 对象,dsn 为可选字符串)」/400「尚未配置错误上报 DSN,无法发送测试事件」/400（DSN inspection）。
- **审计**：`error_reporting_test`。

### 5.6 `GET /api/server/admin/gateway/error-reporting/clients`

- **响应**（200）：
  ```json
  {
    "ready":0,"disabled":0,"failed":0,"config_unavailable":0,"idle":0,
    "last_report_at":"<RFC3339>|",
    "total":0,
    "items":[{"username":"...","state":"...","reason":"...","dsn_host":"...",
              "level":"...","release":"...","updated_at":"<RFC3339>"}]
  }
  ```
  `last_report_at` = items[0].UpdatedAt（空串或 RFC3339）；`total` = 五状态计数之和；`items` ≤100（updated_at DESC）。
- **错误**：500 `INTERNAL`「查询失败」。

---

## 6. 并发与 server-info

### 6.1 `GET /api/server/admin/concurrency`

- **鉴权**：AdminSession + `gateway:read`。
- **响应**（200）：
  ```json
  {
    "checked_at":"<UTC RFC3339>",
    "models":[
      {"model":"m1","current":3,"peak_90d":12,"peak_day":"<RFC3339>|omitempty",
       "target":8,"provider":"..."}
    ]
  }
  ```
  字段：`model`、`current`（进程内 in-flight，仅>0）、`peak_90d`（90 天峰值）、`peak_day`（omitempty）、`target`（`default_params.concurrency_target`，<0→0）、`provider`（omitempty）。合并三来源，排序：peak 降序 → current 降序 → model 名升序。
- 无错误分支（DB 读失败时该模型项省略，整体仍 200）。

### 6.2 `GET /api/server/admin/server-info`

> **注意**：本端点**不在 llmgateway/serverstore 实现**，实现于 `server/internal/serverauth/sysinfo.go`（`AdminAPI.handleServerInfo`），挂 `serverauth.AdminRoute(authed, "GET", "/server-info", PermServerInfoRead, d.Admin.ServerInfo)`。鉴权：AdminSession + `server-info:read`。

- **响应**（200）：
  ```json
  {
    "uptime_sec":12345,
    "uptime_human":"3时25分",
    "go_version":"go1.26.6",
    "num_cpu":8,
    "gomaxprocs":8,
    "goroutines":123,
    "mem":{"allocated_mb":12.3,"total_system_mb":45.6,"system_memory_mb":16000.0},
    "load_avg":[0.1,0.2,0.3],
    "disk":{"data_path":"/data","total_gb":100.0,"used_gb":20.0,"free_gb":80.0,"used_pct":20.0},
    "db":{"driver":"pg","tables":{"users":10,"groups":5,"user_groups":8,"settings":40,
          "api_tokens":20,"gateway_providers":3,"models":10,"usage":1000,"apps":0,
          "app_releases":0,"app_grants":0,"audit_logs":500,"admin_sessions":2},
          "total_rows":1598,"disk_bytes":123456,"disk_human":"120.6KB","schema_migrations":85},
    "version":"v2.x.x",
    "update_check":<null|{...}>,
    "balance":{"admission_rejections":0,"last_rejection":<null|{...}>},
    "oidc":{"capacity_rejections":0},
    "audit":{"chain_checked":true,"chain_intact":true,"chain_broken_id":0,
             "chain_checked_at":"<RFC3339>","chain_age_seconds":3600,"chain_stale":false,
             "chain_source":"periodic","chain_checks":10,"chain_rows":500,
             "chain_duration_ms":120,"chain_error":"",
             "write_failures":0,"dropped_entries":0,"retries":0,
             "last_failure":<null|{...}>}
  }
  ```
  `balance.last_rejection` = `serverstore.BalanceAdmissionRejection`（余额闸门最近一条拒绝：用户/端点/模型/依据 non_positive|learned_floor|min_billable|unpriced_model|unbillable_price/要求金额/当时余额）；`update_check` 为 null 时前端静默降级；`audit.last_failure` = `serverstore.AuditFailureInfo`（含 `cause_class=sqlstate:<码>`）。
- **错误**：500 `INTERNAL`「统计失败: <err>」。

---

## 附录 A. 通用错误码速查

| code | HTTP | 出现场景 |
|---|---|---|
| `AUTH_REQUIRED` | 401 | 网关无 Bearer / 未认证 |
| `VALIDATION` | 400 | 缺字段/非法值/请求体非法 JSON/超限 file_id |
| `RATE_LIMITED` | 429 | 限流（gateway.rate_limit）/并发上限（InFlightGuard） |
| `NOT_FOUND` | 404 | 模型不存在或不可用 / provider/model/file 不存在 |
| `INTERNAL` | 500 | DB 查询失败/事务失败/加密失败/审计失败 |
| `UPSTREAM` | 502 | 上游不可用/超时/过大/读取失败/无可用上游 |
| `UPSTREAM_ERROR` | 上游状态码 | sanitizeUpstreamError 非 JSON 收敛 |
| `SERVER` | 503 | 请求体加工并发满/读超时/无文件上游/文件被回收 |
| `METERING_FAILED` | 503 | 计量落账失败（非余额原因） |
| `BALANCE_EXHAUSTED` | 429 | 余额闸门：non_positive/learned_floor/min_billable/settings_unavailable |
| `MODEL_NOT_PRICED` | 429 | 余额闸门：未定价模型（unpriced_model/unbillable_price） |
| `MODEL_ROUTING_UNAVAILABLE` | 429 | 余额闸门：模型目录读取失败（routing_lookup_failed） |
| `FILE_BUSY` | 409 | 文件删除权被持有/正在清理 |
| `FILE_RECLAIMED` | 409 | 文件行在删除期间归了新上传者 |

## 附录 B. settings 键（本契约涉及）

| 键 | 缺省 | 说明 |
|---|---|---|
| `gateway.default_model` | "" | 默认模型 |
| `gateway.rate_limit` | "0" | 每用户每分钟请求数（0=不限，上限 100000） |
| `gateway.unpriced_model_policy` | "reject" | 未定价模型准入（reject/allow） |
| `gateway.max_file_refs` | "600" | 单请求 file_id 引用上限（1~4096） |
| `gateway.body_parse_budget_mb` | "128" | 在飞请求体字节预算 MiB（64~8192） |
| `gateway.file_expiry_days` | "7" | 文件保留上限天（1~30） |
| `gateway.excluded_models.<providerID>` | — | 渠道同步模型排除名单（JSON 数组） |
| `usage.peak_windows` | "" | 高峰时段 JSON（北京时间；空=无峰谷价） |
| `usage.search_price_per_1k` | "0" | web_search 按次单价元/千次（0~1000） |
| `usage.retention_months` | "6" | usage 明细保留月数（0~120，0=永久） |
| `web.error_reporting_dsn` | "" | 错误上报 DSN |
| `web.error_reporting_enabled` | "false" | 错误上报开关 |
| `web.error_reporting_level` | "" | error/warning/info/debug |
| `web.error_reporting_heartbeat` | "false" | 错误上报心跳 |
| `web.glitchtip_base_url` | "" | GlitchTip 地址 |
| `web.glitchtip_organization` | "" | GlitchTip 组织 |
| `web.default_thinking_level` | "" | off/low/high/max |
| `server.base_url` | "" | 对外地址 |
| `balance.enabled` | — | 员工余额闸门总开关（见 server/AGENTS.md §7） |

## 附录 C. 网关 handler 内部体积上限

| 端点 | 上限常量 | 值 |
|---|---|---|
| chat/completions | `maxChatBody` | 64 MiB |
| messages | `maxMessagesBody` | 64 MiB |
| completions | `maxFIMBody` | 64 MiB |
| responses | `maxResponsesBody` | 64 MiB |
| embeddings | `maxEmbedBody` | 4 MiB |
| files 上传 | `maxFilesUploadBody` | 64 MiB |
| 非流式上游响应 | `maxUpstreamBody` | 32 MiB |
| files 响应 | `maxFilesResponseBody` | 4 MiB |
| 流式单行 | `maxStreamLineBytes` | 1 MiB |
| balance 响应 | `maxBalanceBody` | 1 MiB |
