# 技能商城 + 内置技能 + 共享技能 + 共享 Agent + 能力中心 + 连接器 API 契约

> 提取自 Go 源码（唯一真源：`server/internal/router/optional_skills_on.go`、`optional_connectors_on.go`、`router.go` 路由表 + `server/internal/marketplace/*.go`、`sharedskills/*.go`、`agentshare/*.go`、`capabilities/*.go`、`connectors/*.go`、`skillseed/skillseed.go` 非测试 handler）。
> 所有端点返回 JSON。成功用 `c.JSON(...)`；失败统一信封 `{"error":{"code","message"}}`（经 `serverauth.WriteError`）。
> 例外：归档下载是二进制流（`application/zip` / `application/gzip`，用 `c.Data`），不适用 JSON 信封。

## 通用约定

- **命名空间**：客户端员工面 `/api/client/v2/*`；管理面 `/api/server/admin/*`。
- **鉴权标签**：`public` / `BearerToken`（客户端 bearer，`serverauth.BearerAuth`）/ `AdminSession`（管理会话 + CSRF，`serverauth.AdminAuth`）/ `AdminSession+权限点`（RBAC，`serverauth.AdminRoute` 申报）。
- **权限点全名**（`server/internal/serverauth/rbac.go:38-43`）：`market:read`、`market:write`、`capability:read`、`capability:write`、`connector:read`、`connector:write`（本文涉及的全部权限点）。
- **错误码集合**（本文涉及，信封 `code` 字段取值）：`AUTH_REQUIRED`、`FORBIDDEN`、`NOT_FOUND`、`VALIDATION`、`INTERNAL`、`PAYLOAD_TOO_LARGE`（413）、`ARCHIVE_INVALID`（422）、`ARCHIVE_CLEARED`（409）、`CONFLICT`（409）、`APPROVED_NOT_REJECTABLE`（409，`serverstore.CodeReleaseNotRejectable`）、`APP_DELISTED`（409，`appstore.CodeAppDelisted`）、`NAME_TAKEN`（409）、`INVALID_APP_ID`（422，`skillmanifest.CodeInvalidAppID`）、`APP_LOCKED`（403）、`OFFICIAL_LOCKED`（403）。
- **可见性双门制**（全文档贯穿）：商城技能（market）与共享内容（org 的 shared_skills / agent_presets）均为 **审核 + 授权** 双门制。上架/审核通过后，**未授权用户一律不可见不可用**（404 不泄露存在性）；授权对象 = 用户或部门组（组名大小写不敏感，webadmin 发 `@组名` 前缀会被剥掉）；admin 恒全量（不落授权表）。授权变更审计 `audit_logs`。
- **渠道口径**：market 命名空间（市场技能 `/api/server/admin/skills`、市场智能体 `/api/server/admin/agents`）只服务 `channel='market'` 行；org 命名空间（共享技能 `/api/server/admin/shared-skills`、共享 Agent `/api/server/admin/agent-presets`）只服务 `channel='org'` 行。跨渠道访问一律按「不存在」404（`marketplace/channel.go` 的 `requireMarketAdminApp` / `requireMarketAgent`、`sharedskills/channel.go` 与 `agentshare/channel.go` 的 `requireOrgSkill` / `requireOrgAgent`）。
- **归档限制**（`sharedskills/routes.go` 与 `agentshare/archive.go`）：单归档 ≤16 MiB、解包总量 ≤64 MiB、条目数 ≤10000；上传请求体 ≤24 MiB（`MaxBodyBytes=24<<20`）；文件预览 ≤128 KiB（`maxFilePreviewBytes=128<<10`）。
- **完整性头**：四类下载端点（市场技能 / 共享技能 / 市场智能体 / 共享 Agent）的 `X-*-Checksum` 空值兜底统一走 `sharedskills.ArchiveChecksum(recorded, payload)`：`recorded` 非空返回原值，否则现算 `sha256(payload)` 十六进制。
- **审核拒绝即释放存储**：拒绝一个待审版本会在同一条 `UPDATE` 里置 `rejected` 并清空归档字节；此后该版本不可再 approve（`ARCHIVE_CLEARED`），版本号永久占位不可复用。

## 通用嵌套结构

### `skillJSON`（市场技能对象，`marketplace/skill_api.go:247`）
| key | 类型 | 说明 |
|---|---|---|
| `id` | int64 | |
| `name` | string | 目录名（App ID） |
| `version` | string | 展示版本 |
| `description` | string | |
| `author` | string | 归属人（= `apps.owner`） |
| `checksum` | string | 归档 sha256（可为空） |
| `enabled` | bool | `s.Enabled == 1` |
| `downloads` | int64 | |
| `calls` | int64 | |
| `official` | bool | `s.Official == 1` |
| `created_at` | string(RFC3339) | |
| `updated_at` | string(RFC3339) | |

### `agentJSON`（市场智能体对象，`marketplace/agent_api.go`）
| key | 类型 | 说明 |
|---|---|---|
| `name` | string | App ID |
| `title` | string | 显示名 |
| `description` | string | |
| `author` | string | 归属人（`apps.owner`） |
| `enabled` | bool | `a.Enabled == 1` |
| `official` | bool | `a.Official == 1` |
| `created_at` | string(RFC3339) | |
| `updated_at` | string(RFC3339) | |
| `version` | string | 仅当存在当前展示 release 时 |
| `quality` | string | 仅当存在 release（空 / `featured`） |
| `downloads` | int64 | 仅当存在 release |
| `changelog` | string | 仅当存在 release |

### `sharedSkillRow`（组织共享技能对象，`sharedskills/routes.go:109` `rowJSON`）
| key | 类型 | 说明 |
|---|---|---|
| `name` | string | |
| `display_name` | string | |
| `version` | string | |
| `description` | string | |
| `author` | string | |
| `status` | string | `pending` / `approved` / `rejected` |
| `reason` | string | 拒绝理由 |
| `quality` | string | 空 / `featured`（`official` 已移交） |
| `downloads` | int64 | |
| `calls` | int64 | |
| `created_at` | string(RFC3339) | |
| `updated_at` | string(RFC3339) | |

### `presetJSON`（组织共享 Agent 预设对象，`agentshare/routes.go`）
| key | 类型 | 说明 |
|---|---|---|
| `name` | string | |
| `display_name` | string | |
| `description` | string | |
| `version` | string | |
| `author` | string | |
| `status` | string | `pending` / `approved` / `rejected` |
| `reason` | string | |
| `quality` | string | 空 / `featured` |
| `downloads` | int64 | |
| `created_at` | string(RFC3339) | |
| `updated_at` | string(RFC3339) | |

### `grantJSON`（授权对象，`serverstore/grants.go:17` `Grant`）
| key | 类型 | 说明 |
|---|---|---|
| `grantee_type` | string | `user` / `group` |
| `grantee` | string | 用户名 / 部门名（无 `@` 前缀） |

### `connectorJSON`（连接器对象，`connectors/admin.go:34` `rowJSON`）
| key | 类型 | 说明 |
|---|---|---|
| `id` | string | 小写字母数字连字符 |
| `name` | string | |
| `description` | string | |
| `auth_mode` | string | `oauth` / `device` / `token` / `server-side` / `auto` |
| `definition` | string | 定义 JSON（含 `mcp` + `serverName`） |
| `enabled` | bool | |
| `updated_at` | string | |
| `created_at` | string | |

### `CapabilityItem`（能力中心聚合行，`capabilities/capabilities.go:46`）
| key | 类型 | 说明 |
|---|---|---|
| `kind` | string | `skill` / `agent` |
| `source` | string | `market` / `org` |
| `name` | string | |
| `display_name` | string | |
| `version` | string | |
| `description` | string | |
| `author` | string | |
| `status` | string | 市场行恒 `approved`；org 行随行状态 |
| `reason` | string(omitempty) | |
| `quality` | string(omitempty) | |
| `official` | bool | |
| `downloads` | int64 | |
| `calls` | int64 | |
| `score` | int64 | `calls*3 + downloads` |
| `is_owner` | bool | 当前用户是否为归属人 |
| `delisted` | bool | 已下架（仅「我的」分区可能为 true） |
| `versions` | []string | 该名全部 approved 版本（数值感知升序） |

### `ApprovalRow`（统一审批队列行，`capabilities/capabilities.go:783`）
| key | 类型 | 说明 |
|---|---|---|
| `kind` | string | `skill` / `agent` |
| `name` | string | |
| `version` | string | |
| `display_name` | string | |
| `description` | string | |
| `author` | string | 本行上传者 |
| `owner` | string | 归属人（`apps.owner`，可与 author 不同） |
| `status` | string | |
| `reason` | string(omitempty) | |
| `quality` | string(omitempty) | |
| `created_at` | string(`2006-01-02 15:04:05`) | |
| `downloads` | int64 | |
| `calls` | int64(omitempty) | 仅共享技能有 |
| `base_path` | string | 原域审核端点基路径（含版本段） |
| `grants_base` | string | 授权端点基路径（name-only，无版本段） |
| `preview_path` | string | 域预览端点 |
| `conflict` | bool | 恒 `false`（跨渠道同名结构上不可能） |
| `official` | bool | |
| `enabled` | bool | 上下架状态（App 级） |

---

# 1. 技能商城（员工面）

## 1.1 GET /api/client/v2/marketplace/skills
- 鉴权：BearerToken
- query/path 参数：无
- 成功响应 200：`{"skills":[ …skillJSON… ]}`（仅启用 + 授权可见的行；admin 全量）
- 错误：500 `INTERNAL`「技能列表读取失败」
- 特殊行为：可见性 = `ListSkills(DB, true)`（enabled）后按 `AccessibleSkillNames` 过滤；admin 不过滤。授权查询失败 → 500（不落 404）。

## 1.2 GET /api/client/v2/marketplace/skills/:name
- 鉴权：BearerToken
- path 参数：`name`（技能目录名）
- 成功响应 200：`{"skill":{ …skillJSON… }}`
- 错误：
  - 技能不存在 → 404 `NOT_FOUND`「技能不存在」
  - 非 admin 且未授权 → 404 `NOT_FOUND`「技能不存在」（不泄露存在性）
  - 授权查询失败 → 500 `INTERNAL`「授权查询失败，请稍后重试」
  - `enabled != 1`（下架）→ 404 `NOT_FOUND`「技能已下架」
  - 其它 → 500 `INTERNAL`「技能读取失败」
- 特殊行为：授权检查**先于**下架检查——未授权用户对「存在但下架」与「不存在」得到同一 404。

## 1.3 GET /api/client/v2/marketplace/skills/:name/archive
- 鉴权：BearerToken
- path 参数：`name`
- 成功响应 200：二进制归档流。
- 错误：
  - 不存在 → 404 `NOT_FOUND`「技能不存在」
  - 未授权 → 404 `NOT_FOUND`「技能不存在」
  - 下架 → 404 `NOT_FOUND`「技能已下架」
  - 名称不合法 → 400 `VALIDATION`「技能名不合法」
  - 未上传归档 → 404 `NOT_FOUND`「技能尚未上传归档」
- 响应头：`Content-Type`（`application/zip` / `application/gzip` 按魔数嗅探）、`Content-Disposition: attachment; filename="name-version.zip|.tar.gz"`、`X-Skill-Version`、`X-Skill-Checksum`（空 checksum 现算 sha256）。
- 特殊行为：下载计数 `IncrementSkillDownload(name)`；授权先于下架；下架即不可下载（与不存在同响应）。

---

# 2. 技能商城（管理面）

## 2.1 GET /api/server/admin/skills
- 鉴权：AdminSession+`market:read`
- 成功响应 200：`{"skills":[ …skillJSON… ]}`（全量，含下架）
- 错误：500 `INTERNAL`「查询失败」

## 2.2 POST /api/server/admin/skills
- 鉴权：AdminSession+`market:write`
- 请求体：`name` (string, required)、`version` (string)、`description` (string)、`author` (string)
- 成功响应 200：`{"skill":{ …skillJSON… }}`（新行，`enabled=true`）
- 错误：
  - `name` 空 → 400 `VALIDATION`「名称必填」
  - `IsAppID` 失败 → 400 `INVALID_APP_ID`「技能名不合法:必须是小写 kebab-case」
  - `AddSkill` 重复 → 400 `VALIDATION`「技能已存在」
  - 与组织共享库同名 → 409 `CONFLICT`「名称与组织共享库技能冲突…」
- 特殊行为：审计 `skill_create`。

## 2.3 POST /api/server/admin/skills/:name/archive
- 鉴权：AdminSession+`market:write`
- path 参数：`name`
- 请求体：`version` (string, required)、`archive` (string, required, base64 编码的 zip/tar.gz)
- 成功响应 200：`{"ok":true,"version":"<新版本>","checksum":"<sha256>"}`
- 错误：
  - 名称不合法 → 400 `VALIDATION`「技能名不合法」
  - 技能不存在 → 404 `NOT_FOUND`「技能不存在」
  - `version` 空 → 400 `VALIDATION`「version 与 archive 必填」
  - `version` 含 `/` 或 `\` → 400 `VALIDATION`「版本不合法」
  - base64 解码失败/空 → 400 `VALIDATION`「归档编码错误或为空」
  - 归档 >16 MiB → 413 `VALIDATION`「归档过大(上限 16MB)」
  - 归档校验失败 → 422 `ARCHIVE_INVALID`「归档校验失败: …」
  - SKILL.md 校验失败 → 422 `ARCHIVE_INVALID`「SKILL.md 校验失败」（或 skillmanifest 错误码 + 文案）
  - `appstore.Publish` 失败 → 按其 `Status/Code/Message`（含 409 `NAME_TAKEN`、409 `APP_DELISTED`、403 `APP_LOCKED`、403 `OFFICIAL_LOCKED` 等）
- 特殊行为：限体 `MaxBytesReader` 24 MiB；`ValidateSkillArchive`→`ListArchiveContents`→`skillmanifest.Parse`；`appstore.Publish(AdminPublish=true, AppChannelMarket)`；成功后 `SetSkillDisplayName(man.Title)`；审计 `skill_update`。

## 2.4 PUT /api/server/admin/skills/:name
- 鉴权：AdminSession+`market:write`
- path 参数：`name`
- 请求体：`name`、`version`、`description`、`author`（`skillReq`）
- 成功响应 200：`{"skill":{ …skillJSON… }}`
- 错误：
  - 不存在 → 404 `NOT_FOUND`「技能不存在」/ 其它 → 500
  - `req.Version` 与当前不同 → 400 `VALIDATION`「请用「上传新版」随归档一起更改版本」
  - `req.Author` 与当前不同 → 400 `VALIDATION`「归属(负责人)不能在这里修改…」
- 特殊行为：`description` 非空才覆盖；`UpdateSkillMeta` 只写 title/description/enabled，不碰 owner。

## 2.5 DELETE /api/server/admin/skills/:name
- 鉴权：AdminSession+`market:write`
- path 参数：`name`
- 成功响应 200：`{"ok":true}`
- 错误：跨渠道/不存在 → 404 `NOT_FOUND`「技能不存在」
- 特殊行为：软下架（`SetSkillEnabled(false)`）；审计 `skill_disable`。

## 2.6 POST /api/server/admin/skills/:name/enable
- 鉴权：AdminSession+`market:write`
- 成功响应 200：`{"ok":true}`
- 特殊行为：`SetSkillEnabled(true)`；审计 `skill_enable`。

## 2.7 GET /api/server/admin/skills/:name/preview
- 鉴权：AdminSession+`market:read`
- path 参数：`name`
- 成功响应 200：`{"files":[...],"skill_md":"...","name":"...","version":"...","checksum":"..."}`
- 错误：名称不合法 → 400；不存在 → 404「技能不存在」/ 500；无归档 → 404；归档解析失败 → 422
- 特殊行为：归档空时磁盘回退（`name-version.zip|.tar.gz`）。

## 2.8 GET /api/server/admin/skills/:name/file?path=...
- 鉴权：AdminSession+`market:read`
- path 参数：`name`；query 参数：`path`（归档内路径，required）
- 成功响应 200：`{"path":"...","size":N,"binary":bool,"too_large":bool,"content":"..."}`
- 错误：名称不合法 → 400；`path` 空 → 400 `VALIDATION`「缺少文件路径」；`path` 非法 → 400 `VALIDATION`「文件路径不合法」；不存在 → 404 / 500；无归档 → 404；解析失败 → 422 `ARCHIVE_INVALID`；文件不存在 → 404 `NOT_FOUND`「归档中不存在该文件」
- 特殊行为：路径经 `archiveutil.NormalizePath`；内容上限 128 KiB。

## 2.9 GET /api/server/admin/skills/:name/archive
- 鉴权：AdminSession+`market:read`
- path 参数：`name`
- 成功响应 200：二进制归档流（头同 1.3）。
- 错误：名称不合法 → 400；不存在 → 404 / 500；未上传归档 → 404「技能尚未上传归档」
- 特殊行为：与员工面共用 `serveSkillArchive`（不额外过闸门，管理员可下载任何行，含下架）。

## 2.10 POST /api/server/admin/skills/:name/normalize
- 鉴权：AdminSession+`market:write`
- path 参数：`name`
- 请求体：无（作用于已存归档）
- 成功响应 200（已合规）：`{"ok":true,"version":"...","checksum":"...","changes":[],"already_compliant":true}`
- 成功响应 200（重写）：`{"ok":true,"version":"<nextVersion>","checksum":"<sha256>","changes":[...]}`
- 错误：归档缺失 → 422 `ARCHIVE_INVALID`「归档缺少 SKILL.md」；其它归档/清单错误 → 422
- 特殊行为：`BumpPatch`→`NormalizeSkillMD`→`forceVersion`→重建 zip→校验→`ReplaceSkillArchive`；审计 `skill_normalize`。

## 2.11 GET /api/server/admin/skills/:name/grants
- 鉴权：AdminSession+`market:read`
- path 参数：`name`
- 成功响应 200：`{"grants":[ …grantJSON… ]}`（空则 `[]`）
- 错误：不存在 → 404 `NOT_FOUND`「技能不存在」

## 2.12 PUT /api/server/admin/skills/:name/grants
- 鉴权：AdminSession+`market:write`
- 请求体：`groups` ([]string, required)（部门名列表，整体替换部门级授权）
- 成功响应 200：`{"ok":true}`
- 错误：请求体含未知字段 → 400 `VALIDATION`「请求体错误(仅接受 groups 字段)」；存在不认识的部门名 → 400 `VALIDATION`「存在不认识的部门名称」；其它 → 500 `VALIDATION`「操作失败」
- 特殊行为：`ReplaceSkillGroupGrants` 事务内整体替换部门级授权；审计 `skill_grants_replace`。

## 2.13 PUT /api/server/admin/skills/:name/grant
- 鉴权：AdminSession+`market:write`
- 请求体：`username` (string) 或 `group` (string)（二选一，`grantReq`）
- 成功响应 200：`{"ok":true}`
- 错误：
  - 两者都空/都填 → 400 `VALIDATION`「username 或 group 必填且只能二选一」
  - 用户不存在 → 400 `VALIDATION`「用户不存在: x」
  - 部门不存在 → 400 `VALIDATION`「部门不存在: x」
  - grant 失败 → 400 `VALIDATION`「授权对象不合法」
- 特殊行为：审计 `skill_grant`。

## 2.14 DELETE /api/server/admin/skills/:name/grant
- 鉴权：AdminSession+`market:write`
- 请求体：同 2.13
- 成功响应 200：`{"ok":true}`
- 特殊行为：审计 `skill_revoke`。

## 2.15 GET /api/server/admin/agents
- 鉴权：AdminSession+`market:read`
- 成功响应 200：`{"agents":[ …agentJSON… ]}`（含已下架）
- 错误：500 `INTERNAL`「查询失败」

## 2.16 POST /api/server/admin/agents
- 鉴权：AdminSession+`market:write`
- 请求体：`name` (string, required)、`description` (string)、`author` (string)（`agentReq`）
- 成功响应 200：`{"agent":{"name":"...","author":"<owner>"}}`
- 错误：
  - `name` 空 → 400 `VALIDATION`「名称必填」
  - `IsAppID` 失败 → 400 `INVALID_APP_ID`「名称不合法:必须是小写 kebab-case(如 my-agent)」
  - 与组织共享库同名 → 409 `CONFLICT`「名称与组织共享库智能体冲突…」
  - 已存在 → 400 `VALIDATION`「智能体已存在」
- 特殊行为：`owner = req.Author` 空则 `adminUsername`；`UpsertApp(Kind=agent, Channel=market, Enabled=1)`；审计 `agent_create`。

## 2.17 POST /api/server/admin/agents/:name/archive
- 鉴权：AdminSession+`market:write`
- path 参数：`name`
- 请求体：`version` (string)、`archive` (string, required, base64)
- 成功响应 200：`{"ok":true,"version":"<新版本>","checksum":"<sha256>"}`
- 错误：
  - 名称不合法 → 400 `VALIDATION`「智能体名不合法」
  - 不存在 → 404 `NOT_FOUND`「智能体不存在」
  - `archive` 空 → 400 `VALIDATION`「archive 必填」
  - base64 解码空 → 400 `VALIDATION`「归档编码错误或为空」
  - 归档/编排/preset.yml 校验失败 → 422 `ARCHIVE_INVALID`（或 skillmanifest 错误码）
- 特殊行为：`ValidatePresetArchive`→`ListArchiveContents`→`ValidateAgentComposition`（根 `agent.cordis.yml`）→`ExtractFileContent(preset.yml)`→`skillmanifest.ParseAgent`→`appstore.Publish(Kind=agent, Channel=market, Publisher=admin, AdminPublish=true)`；`SetAppTitle(man.Title)` 只写标题；审计 `agent_update`。

## 2.18 PUT /api/server/admin/agents/:name
- 鉴权：AdminSession+`market:write`
- path 参数：`name`
- 请求体：`name`、`description`、`author`（`agentReq`）
- 成功响应 200：`{"ok":true}`
- 错误：名称不合法 → 400「智能体名不合法」；坏 body → 400「请求体错误」；不存在/跨渠道 → 404「智能体不存在」/ 500
- 特殊行为：`title = req.Name` 空则保持；`desc = req.Description` 空则保持；不碰 owner；审计 `agent_update_meta`。

## 2.19 DELETE /api/server/admin/agents/:name
- 鉴权：AdminSession+`market:write`
- path 参数：`name`
- 成功响应 200：`{"ok":true}`
- 错误：不存在/跨渠道 → 404「智能体不存在」；下架失败 → 404/500「下架失败」
- 特殊行为：`SetAppEnabled(false)`；审计 `agent_disable`。

## 2.20 POST /api/server/admin/agents/:name/enable
- 鉴权：AdminSession+`market:write`
- 成功响应 200：`{"ok":true}`
- 错误：不存在/跨渠道 → 404；上架失败 → 404/500「上架失败」
- 特殊行为：`SetAppEnabled(true)`；审计 `agent_enable`。

## 2.21 GET /api/server/admin/agents/:name/preview
- 鉴权：AdminSession+`market:read`
- path 参数：`name`
- 成功响应 200：`{"files":[...],"composition":"...","version":"..."}`
- 错误：跨渠道 → 404「智能体不存在」；无 release → 404「智能体尚未发布版本」；归档解析失败 → 422「归档解析失败」
- 特殊行为：`requireMarketAgent`（org 行按不存在）。

## 2.22 GET /api/server/admin/agents/:name/file?path=...
- 鉴权：AdminSession+`market:read`
- path 参数：`name`；query：`path`（required）
- 成功响应 200（文本）：`{"content":"...","size":N}`；二进制：`{"size":N,"binary":true}`；过大：`{"size":N,"too_large":true}`（键名 `too_large` 是跨端契约，勿改驼峰）
- 错误：跨渠道 → 404；无 release → 404；读取失败 → 500「读取失败」；文件不存在 → 404「文件不存在」
- 特殊行为：`requireMarketAgent` 先于解析；内容上限 128 KiB。

## 2.23 GET /api/server/admin/agents/:name/archive
- 鉴权：AdminSession+`market:read`
- path 参数：`name`
- 成功响应 200：二进制归档流。
- 响应头：`Content-Type`（按魔数）、`Content-Disposition: attachment; filename="name-version.zip|.tar.gz"`、`X-Preset-Version`、`X-Preset-Checksum`（空 checksum 现算 sha256）。
- 错误：不存在/跨渠道 → 404「智能体不存在」/ 500；无 release 或归档空 → 404「智能体尚未发布版本」
- 特殊行为：`IncrementAgentPresetDownload(name, version)`。

## 2.24 GET /api/server/admin/agents/:name/grants
- 鉴权：AdminSession+`market:read`
- path 参数：`name`
- 成功响应 200：`{"grants":[ …grantJSON… ]}`（单层，勿多包一层）
- 错误：跨渠道 → 404「智能体不存在」；查询失败 → 500

## 2.25 PUT /api/server/admin/agents/:name/grants
- 鉴权：AdminSession+`market:write`
- 请求体：`groups` ([]string, required)
- 成功响应 200：`{"ok":true}`
- 错误：坏 body → 400「请求体错误(仅接受 groups 字段)」；存在不认识的部门名 → 400「存在不认识的部门名称」；其它 → 500「操作失败」
- 特殊行为：`replaceAgentGroupGrants` 事务内剥 `@`、去重、`GroupByName` 校验、DELETE 旧 group 授权、逐条 INSERT；审计 `agent_grants`。

## 2.26 PUT /api/server/admin/agents/:name/grant
- 鉴权：AdminSession+`market:write`
- 请求体：`username` / `group`（二选一）
- 成功响应 200：`{"ok":true}`
- 错误：坏 body → 400「请求体错误」；两者都空/都填 → 400「username 与 group 必须指定其一」；用户不存在 → 400「用户不存在: x」；部门不存在 → 400「部门不存在: x」
- 特殊行为：`GranteeGroup` 剥 `@` 前缀；审计 `agent_grant`。

## 2.27 DELETE /api/server/admin/agents/:name/grant
- 鉴权：AdminSession+`market:write`
- 请求体：同 2.26
- 成功响应 200：`{"ok":true}`
- 特殊行为：审计 `agent_revoke`。

---

# 3. 内置技能（skillseed）

> 内置技能 = 镜像资产目录（环境变量 `PICOAI_SKILL_SEED_DIR`，否则 `/opt/picoaide/skills`）。静态打包为确定性 tar.gz（条目按名排序、mtime/uid/gid 归零、gzip 头不带名/时间）。根部须有 `SKILL.md`。

## 3.1 GET /api/client/v2/skills/builtin
- 鉴权：BearerToken
- 成功响应 200：`{"skills":[ {name,version,title,description,author,category,sha256,size,files,source:"builtin"}, … ]}`
- 错误：500 `INTERNAL`「内置技能清单读取失败」
- 特殊行为：无授权过滤，所有登录员工可见；每行 `source:"builtin"`。

## 3.2 GET /api/server/admin/skills/builtin
- 鉴权：AdminSession+`capability:read`
- 成功响应 200：`{"dir":"...","dir_exists":bool,"skills":[...],"problems":[...],"counts":{"skills":N,"problems":N},"load_error":"..."?}`
- 特殊行为：只读诊断面——`Load` 失败不返回 5xx，而是 200 带 `load_error` 字段。`skills` 行形状与 3.1 相同；`problems` 每项 `{name, name_bytes_hex?, reason}`。

## 3.3 GET /api/client/v2/skills/builtin/:name/archive
- 鉴权：BearerToken
- path 参数：`name`
- 成功响应 200：二进制 tar.gz。
- 响应头：`Content-Type: application/gzip`、`Content-Disposition: attachment; filename="name-version.tar.gz"`、`X-Skill-Version`、`X-Skill-Checksum`（`entry.SHA256`）。
- 错误：Load 失败 → 500 `INTERNAL`「内置技能读取失败」；名称不存在 → 404 `NOT_FOUND`「内置技能不存在」（不泄露内部诊断）

---

# 4. 共享技能（org，`sharedskills`）

## 4.1 GET /api/client/v2/shared-skills
- 鉴权：BearerToken
- 成功响应 200：`{"skills":[ …sharedSkillRow…（额外加 `enabled: bool`）]}`
- 错误：查询失败 → 500 `INTERNAL`「查询失败」
- 特殊行为：分发面，可见性 = `visibleTo`（`approved` ∧ 未下架 ∧ (admin 全量 ∨ 员工授权/归属)）；列出的行 `enabled` 恒为 true。

## 4.2 POST /api/client/v2/shared-skills
- 鉴权：BearerToken
- 请求体：`name` (string, required)、`display_name` (string)、`version` (string)、`description` (string)、`archive` (string, required, base64)
- 成功响应 201：`{"skill":{"name":"...","version":"<发布版本>","status":"pending"}}`
- 错误：
  - 请求体超限 → 413 `PAYLOAD_TOO_LARGE`「归档过大」
  - 坏 body → 400 `VALIDATION`「请求体格式错误」
  - `name` 非法 → 400 `INVALID_APP_ID`
  - `archive` 空 → 400 `VALIDATION`「缺少归档内容」
  - base64 解码失败 → 400 `VALIDATION`「归档编码错误」
  - 归档校验失败 → 422 `ARCHIVE_INVALID`
  - SKILL.md 校验失败 → 422 `ARCHIVE_INVALID`「SKILL.md 校验失败」
  - 未认证 → 401 `AUTH_REQUIRED`「未认证」
  - `appstore.Publish` 失败 → 按其 `Status/Code/Message`
- 特殊行为：`version` 忽略（包内即真相）；`skillmanifest.IsAppID(name)` 校验；`appstore.Publish(Kind=AppKindSkill, Channel=AppChannelOrg, PendingCap=10, Checksum)`。

## 4.3 GET /api/client/v2/shared-skills/:name/:version/archive
- 鉴权：BearerToken
- path 参数：`name`、`version`
- 成功响应 200：二进制归档流。
- 响应头：`Content-Type`（按魔数）、`Content-Disposition: attachment; filename="name-version.zip|.tar.gz"`、`X-Skill-Version`、`X-Skill-Checksum`（空 checksum 现算 sha256）。
- 错误：
  - 名称/版本非法 → 400 `VALIDATION`「参数不合法」
  - 非 org 渠道 → 404「技能不存在」
  - 不存在 → 404 `NOT_FOUND`「技能不存在」
  - 未认证 → 401 `AUTH_REQUIRED`「未认证」
  - 未授权/未审核/已下架 → 404 `NOT_FOUND`「技能不存在」（不泄露存在性）
  - 归档缺失 → 500 `INTERNAL`「归档数据缺失」/ 读取失败 → 500
- 特殊行为：员工面三重闸门（审核 + 上下架 + 授权），与列表共用 `visibleTo` 判据；`IncrementSharedSkillDownload(name, version)`。

## 4.4 GET /api/server/admin/shared-skills
- 鉴权：AdminSession+`capability:read`
- query 参数：`status`（可选：`pending`/`approved`/`rejected`；空 = 全部）
- 成功响应 200：`{"skills":[ …sharedSkillRow… ]}`
- 错误：500 `INTERNAL`「查询失败」
- 特殊行为：全量（含下架、含非 approved）；org 渠道过滤。

## 4.5 GET /api/server/admin/shared-skills/:name/:version/archive
- 鉴权：AdminSession+`capability:read`
- path 参数：`name`、`version`
- 成功响应 200：二进制归档流（头同 4.3）。
- 错误：名称/版本非法 → 400；非 org → 404「技能不存在」；不存在 → 404「技能不存在」/ 500；归档缺失 → 500
- 特殊行为：admin 只读归档（不过闸门，含下架）。

## 4.6 GET /api/server/admin/shared-skills/:name/:version/preview
- 鉴权：AdminSession+`capability:read`
- path 参数：`name`、`version`
- 成功响应 200：`{"files":[...],"skill_md":"..."}`
- 错误：名称/版本非法 → 400；非 org → 404；不存在 → 404/500；归档缺失 → 500；解析失败 → 422 `ARCHIVE_INVALID`

## 4.7 POST /api/server/admin/shared-skills/:name/:version/approve
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`、`version`
- 请求体：无
- 成功响应 200：`{"ok":true}`
- 错误：
  - 不存在 → 404 `NOT_FOUND`「技能不存在」
  - 与市场技能同名 → 409 `CONFLICT`「名称与市场技能冲突,请先处理市场技能或驳回该共享技能」
  - 非 org 渠道 → 404「技能不存在」
  - 已下架 → 409 `APP_DELISTED`「该技能已下架，无法通过审核：请先重新上架再审核」
  - 归档已清空 → 409 `ARCHIVE_CLEARED`「该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本」
- 特殊行为：`SetReleaseStatusForReview`→`RecomputeAppProjection`；审计 `shared_skill_approve`。

## 4.8 POST /api/server/admin/shared-skills/:name/:version/reject
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`、`version`
- 请求体：`reason` (string, required, ≤500 字)
- 成功响应 200：`{"ok":true}`
- 错误：
  - 坏 body → 400 `VALIDATION`「请求体格式错误」
  - `reason` >500 字 → 400 `VALIDATION`「拒绝理由过长(上限 500 字)」
  - `reason` 空 → 400 `VALIDATION`「请填写拒绝理由」
  - 不存在 → 404「技能不存在」
  - 已 approved 版本不可 reject → 409 `APPROVED_NOT_REJECTABLE`
- 特殊行为：拒绝与释放归档在同一条 `UPDATE` 完成；审计 `shared_skill_reject`。

## 4.9 DELETE /api/server/admin/shared-skills/:name/:version
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`、`version`
- 成功响应 200：`{"ok":true}`
- 错误：不存在 → 404「技能不存在」；删除失败 → 500「删除失败」
- 特殊行为：删行 + 删归档 + 版本数为 0 时清授权。

## 4.10 PUT /api/server/admin/shared-skills/:name/:version/quality
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`、`version`
- 请求体：`quality` (string，空 / `featured`；`official` 已移交)
- 成功响应 200：`{"ok":true,"quality":"..."}`
- 错误：坏 body → 400「请求体格式错误」；非法 → 400 `VALIDATION`「质量标记不合法(空/featured;官方已移交归属官方操作)」；不存在或未过审 → 404「技能不存在或未通过审核」

## 4.11 GET /api/server/admin/shared-skills/:name/:version/file?path=...
- 鉴权：AdminSession+`capability:read`
- path 参数：`name`、`version`；query：`path`（required）
- 成功响应 200：`{"path":"...","size":N,"binary":bool,"too_large":bool,"content":"..."}`
- 错误：参数非法 → 400；`path` 空 → 400「缺少文件路径」；`path` 非法 → 400「文件路径不合法」；不存在 → 404/500；归档缺失 → 500；解析失败 → 422；文件不存在 → 404「归档中不存在该文件」

## 4.12 GET /api/server/admin/shared-skills/:name/grants
- 鉴权：AdminSession+`capability:read`
- path 参数：`name`
- 成功响应 200：`{"grants":[ …grantJSON… ]}`（空则 `[]`）

## 4.13 PUT /api/server/admin/shared-skills/:name/grants
- 鉴权：AdminSession+`capability:write`
- 请求体：`groups` ([]string, required)
- 成功响应 200：`{"ok":true}`
- 错误：坏 body → 400「请求体格式错误」；部门名不合法/不存在 → 400「部门名不合法或不存在」；其它 → 500「授权失败」

## 4.14 PUT /api/server/admin/shared-skills/:name/grant
- 鉴权：AdminSession+`capability:write`
- 请求体：`username` / `group`（二选一）
- 成功响应 200：`{"ok":true}`
- 错误：坏 body → 400「请求体格式错误」；两者都空 → 400「缺少授权主体」；主体不存在 → 400「授权主体不存在」；不合法 → 400「授权主体不合法」；其它 → 500「授权失败」

## 4.15 DELETE /api/server/admin/shared-skills/:name/grant
- 鉴权：AdminSession+`capability:write`
- 请求体：同 4.14
- 成功响应 200：`{"ok":true}`

## 4.16 PUT /api/server/admin/shared-skills/:name/enabled
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`
- 请求体：`enabled` (*bool, required)
- 成功响应 200：`{"ok":true,"enabled":bool}`
- 错误：参数非法 → 400「参数不合法」；坏 body → 400「请求体格式错误(需要 {"enabled": true|false})」；不存在 → 404「技能不存在」；其它 → 500「切换失败」
- 特殊行为：审计 `shared_skill_enable`/`shared_skill_disable`。

---

# 5. 共享 Agent（org，`agent-presets` / `agentshare`）

## 5.1 GET /api/client/v2/agent-presets
- 鉴权：BearerToken
- 成功响应 200：`{"presets":[ …presetJSON… ]}`
- 特殊行为：管理员 `approved ∧ org[p.Name] ∧ enabled[p.Name]`；员工 `ListVisibleAgentPresets` + org 过滤。

## 5.2 POST /api/client/v2/agent-presets
- 鉴权：BearerToken
- 请求体：`name` (string, required)、`description` (string)、`display_name` (string)、`version` (string，空则 `"1.0.0"`)、`archive` (string, required, base64)
- 成功响应 201：`{"preset":{"name":"...","version":"<发布版本>","status":"pending"}}`
- 错误：归档校验失败 → 422 `ARCHIVE_INVALID`；`name` 非法 / `version` 非法 / `archive` 空 / base64 解码失败 → 400 `VALIDATION`；`appstore.Publish` 失败 → 按其 `Status/Code/Message`
- 特殊行为：`ValidatePresetArchive`→`ListArchiveContents`→`ValidateAgentComposition`→`ExtractFileContent(preset.yml)`→`skillmanifest.ParseAgent`；`appstore.Publish(Kind=AppKindAgent, Channel=AppChannelOrg, PendingCap=10)`；审计 `agent_preset_upload`。

## 5.3 GET /api/client/v2/agent-presets/:name/archive
- 鉴权：BearerToken
- path 参数：`name`
- 成功响应 200：二进制归档流。
- 响应头：`Content-Type`（按魔数）、`Content-Disposition: attachment; filename="name-version.zip|.tar.gz"`、`X-Preset-Version`、`X-Preset-Checksum`（空 checksum 现算 sha256）。
- 特殊行为：按 `:name` 取当前展示版本；员工面（admin=false）**两渠道都服务**（市场智能体安装通路）；`IncrementAgentPresetDownload(name, version)`。

## 5.4 GET /api/client/v2/agent-presets/:name/:version/archive
- 鉴权：BearerToken
- path 参数：`name`、`version`
- 成功响应 200：二进制归档流（头同 5.3）。
- 特殊行为：按 `:name/:version` 精确寻址；员工面两渠道都服务。

## 5.5 GET /api/server/admin/agent-presets
- 鉴权：AdminSession+`capability:read`
- query 参数：`status`（可选）
- 成功响应 200：`{"presets":[ …presetJSON… ]}`
- 特殊行为：org 渠道过滤；全量（含非 approved、下架）。

## 5.6 GET /api/server/admin/agent-presets/:name/archive
- 鉴权：AdminSession+`capability:read`
- path 参数：`name`
- 成功响应 200：二进制归档流（头同 5.3）。
- 特殊行为：admin 只服务 org 行；按 `:name` 取当前展示版本。

## 5.7 GET /api/server/admin/agent-presets/:name/preview
- 鉴权：AdminSession+`capability:read`
- path 参数：`name`
- 成功响应 200：`{"files":[...],"composition":"..."}`
- 错误：不存在 → 404「预设不存在」；非 org → 404；归档缺失 → 500；解析失败 → 422 `ARCHIVE_INVALID`

## 5.8 POST /api/server/admin/agent-presets/:name/approve
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`
- 请求体：无
- 成功响应 200：`{"ok":true}`
- 错误：不存在 → 404「预设不存在」；非 org → 404；已下架 → 409 `APP_DELISTED`；归档空 → 409 `ARCHIVE_CLEARED`；已 approved 不可 reject（对应 reject 端点）→ 409 `APPROVED_NOT_REJECTABLE`
- 特殊行为：`GetAgentPresetForReview`（最高非 approved 版本）；`SetReleaseStatusForReview`→`RecomputeAppProjection`；审计 `agent_preset_approve`。

## 5.9 POST /api/server/admin/agent-presets/:name/reject
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`
- 请求体：`reason` (string, required, ≤500 字)
- 成功响应 200：`{"ok":true}`
- 特殊行为：审计 `agent_preset_reject`。

## 5.10 DELETE /api/server/admin/agent-presets/:name
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`
- 成功响应 200：`{"ok":true}`
- 特殊行为：软删全版本 `softDeleteAllPresetVersions`（单条 UPDATE）+ 清磁盘缓存 + `DeleteSharedResourceGrants`。

## 5.11 GET /api/server/admin/agent-presets/:name/:version/archive
- 鉴权：AdminSession+`capability:read`
- path 参数：`name`、`version`
- 成功响应 200：二进制归档流（头同 5.3）。
- 特殊行为：admin 只服务 org 行；按版本精确寻址。

## 5.12 GET /api/server/admin/agent-presets/:name/:version/preview
- 鉴权：AdminSession+`capability:read`
- path 参数：`name`、`version`
- 成功响应 200：`{"files":[...],"composition":"..."}`

## 5.13 POST /api/server/admin/agent-presets/:name/:version/approve
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`、`version`
- 请求体：无
- 成功响应 200：`{"ok":true}`
- 特殊行为：`GetAgentPresetByVersion` 精确寻址；审计 `agent_preset_approve`。

## 5.14 POST /api/server/admin/agent-presets/:name/:version/reject
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`、`version`
- 请求体：`reason` (string, required, ≤500 字)
- 成功响应 200：`{"ok":true}`
- 特殊行为：审计 `agent_preset_reject`。

## 5.15 DELETE /api/server/admin/agent-presets/:name/:version
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`、`version`
- 成功响应 200：`{"ok":true}`
- 特殊行为：`DeleteAgentPresetByVersion` + `ClearAgentPresetArchive` + 删磁盘。

## 5.16 PUT /api/server/admin/agent-presets/:name/:version/quality
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`、`version`
- 请求体：`quality` (string，空 / `featured`)
- 成功响应 200：`{"ok":true,"quality":"..."}`
- 特殊行为：`ValidAgentQuality`（空/featured，official 已移交）；审计 `agent_preset_qualify`。

## 5.17 GET /api/server/admin/agent-presets/:name/:version/file?path=...
- 鉴权：AdminSession+`capability:read`
- path 参数：`name`、`version`（`version` 可空，空则取该名最新行，兼容旧调用方）；query：`path`（required）
- 成功响应 200：`{"path":"...","size":N,"binary":bool,"too_large":bool,"content":"..."}`
- 错误：名称非法 → 400「预设名不合法」；版本非法 → 400「版本号不合法」；`path` 空 → 400「缺少文件路径」；`path` 非法 → 400「文件路径不合法」；不存在 → 404「预设不存在」；非 org → 404；归档缺失 → 500；解析失败 → 422；文件不存在 → 404「归档中不存在该文件」

## 5.18 GET /api/server/admin/agent-presets/:name/grants
- 鉴权：AdminSession+`capability:read`
- path 参数：`name`
- 成功响应 200：`{"grants":[ …grantJSON… ]}`（空则 `[]`）

## 5.19 PUT /api/server/admin/agent-presets/:name/grants
- 鉴权：AdminSession+`capability:write`
- 请求体：`groups` ([]string, required)
- 成功响应 200：`{"ok":true}`
- 特殊行为：`ReplaceSharedGroups`；审计 `agent_preset_grant`。

## 5.20 PUT /api/server/admin/agent-presets/:name/grant
- 鉴权：AdminSession+`capability:write`
- 请求体：`username` / `group`（二选一）
- 成功响应 200：`{"ok":true}`
- 错误：主体不存在 → 400；`grantSubject` 二选一失败 → 400
- 特殊行为：`GrantSharedResource`；审计 `agent_preset_grant`。

## 5.21 DELETE /api/server/admin/agent-presets/:name/grant
- 鉴权：AdminSession+`capability:write`
- 请求体：同 5.20
- 成功响应 200：`{"ok":true}`
- 特殊行为：`RevokeSharedResource`；审计 `agent_preset_revoke`。

## 5.22 PUT /api/server/admin/agent-presets/:name/enabled
- 鉴权：AdminSession+`capability:write`
- path 参数：`name`
- 请求体：`enabled` (*bool, required)
- 成功响应 200：`{"ok":true,"enabled":bool}`
- 特殊行为：`SetAppEnabled(AppKindAgent)`；审计 `agent_preset_enable`/`agent_preset_disable`。

---

# 6. 能力中心与锁定（`capabilities`）

## 6.1 GET /api/client/v2/capabilities
- 鉴权：BearerToken
- query 参数：
  - `source`（可选）：`market`（合并结果，市场优先）/ `org`（仅组织，兼容旧客户端）/ 空（全量）/ `own` / `local`（「我的」分区，客户端 `/api/pico/capabilities?source=local` 经宿主转换为 `source=own`）
  - `type`（可选）：`all`（默认）/ `skill` / `agent` / 逗号列表（`skill,agent`）
- 成功响应 200：`{"items":[ …CapabilityItem… ]}`
- 错误：授权/分发/官方属性等查询失败 → 500 `INTERNAL`「查询失败」
- 特殊行为：
  - 聚合三源：市场技能（enabled+授权）、市场智能体（enabled+授权）、组织共享技能/共享 Agent（作者任意状态 own 或 approved+授权；admin 恒全量）。
  - 同名（kind+name）多版本归并为一条（最高 approved 版本为展示行），`versions` 携带全部 approved 版本。
  - `?source=market` 同名折叠市场优先；`?source=org` 仅组织。
  - 非 own/local 源按「官方 → 精选(featured) → score 降序 → 名称升序」排序；own/local 不排序。

## 6.2 GET /api/server/admin/capabilities/approvals
- 鉴权：AdminSession+`capability:read`
- query 参数：`status`（可选：`pending`（默认）/ `all` / `approved` / `rejected`）、`type`（可选：`skill` / `agent` / 逗号列表 / 空 = 全部）
- 成功响应 200：`{"approvals":[ …ApprovalRow… ]}`
- 错误：查询失败 → 500 `INTERNAL`「查询失败」
- 特殊行为：只读统一审批队列；审核动作（approve/reject/delete）仍走各自原域端点；`base_path`/`preview_path` 指向 `/api/server/admin` 命名空间原域端点。

## 6.3 GET /api/server/admin/capability-locks
- 鉴权：AdminSession+`capability:read`
- 成功响应 200：`{"locks":[ {kind,name,reason,locked_by,created_at}, … ]}`
- 错误：查询失败 → 500「查询失败」

## 6.4 PUT /api/server/admin/capability-locks/:kind/:name
- 鉴权：AdminSession+`capability:write`
- path 参数：`kind`（`skill` / `agent`）、`name`（须 `IsAppID`）
- 请求体：`reason` (string, ≤500 字)
- 成功响应 200：`{"ok":true}`
- 错误：`kind` 非法 → 400 `VALIDATION`「类型不合法(skill|agent)」；`name` 非法 → 400 `INVALID_APP_ID`；`reason` 超长 → 400「理由过长(上限 500 字)」；其它 → 500「锁定失败」

## 6.5 DELETE /api/server/admin/capability-locks/:kind/:name
- 鉴权：AdminSession+`capability:write`
- path 参数：`kind`、`name`
- 成功响应 200：`{"ok":true}`
- 错误：参数非法 → 400「参数不合法」；未锁定 → 404 `NOT_FOUND`「该名称未被锁定」；其它 → 500「解锁失败」

---

# 7. 连接器（`connectors`）

## 7.1 GET /api/server/admin/connectors
- 鉴权：AdminSession+`connector:read`
- 成功响应 200：`{"connectors":[ …connectorJSON… ]}`
- 错误：500 `INTERNAL`「查询失败」

## 7.2 GET /api/server/admin/connectors/:id
- 鉴权：AdminSession+`connector:read`
- path 参数：`id`
- 成功响应 200：`{"connector":{ …connectorJSON… }}`
- 错误：不存在 → 404 `NOT_FOUND`「连接器不存在」；其它 → 500「查询失败」

## 7.3 POST /api/server/admin/connectors
- 鉴权：AdminSession+`connector:write`
- 请求体：`id` (string)、`name` (string)、`description` (string)、`auth_mode` (string)、`definition` (string)、`enabled` (*bool，缺省 true)
- 成功响应 201：`{"connector":{ …connectorJSON… }}`
- 错误：
  - 坏 body → 400 `VALIDATION`「请求体格式错误」
  - 定义 JSON >64 KiB → 400 `VALIDATION`「定义 JSON 过长」
  - 参数不合法（id 小写字母数字连字符 / 名称 / 认证模式 / 定义 JSON 含 mcp+serverName）→ 400 `VALIDATION`「连接器参数不合法(id 小写字母数字/名称/认证模式/定义 JSON 须含 mcp+serverName)」
  - id 重复 → 409 `CONFLICT`「连接器 id 已存在」
  - 其它 → 500「创建失败」
- 特殊行为：审计 `connector_create`。

## 7.4 PUT /api/server/admin/connectors/:id
- 鉴权：AdminSession+`connector:write`
- path 参数：`id`
- 请求体：同 7.3（`enabled` 省略时保持现值，PATCH 语义）
- 成功响应 200：`{"connector":{ …connectorJSON… }}`
- 错误：不存在 → 404「连接器不存在」；参数不合法 → 400 `VALIDATION`「连接器参数不合法」；其它 → 500「更新失败」
- 特殊行为：`conn.ID = id`（id 不可经 body 修改）；审计 `connector_update`。

## 7.5 PUT /api/server/admin/connectors/:id/enabled
- 鉴权：AdminSession+`connector:write`
- path 参数：`id`
- 请求体：`enabled` (*bool, required)
- 成功响应 200：`{"ok":true}`
- 错误：缺 `enabled` → 400 `VALIDATION`「缺少 enabled 字段」；不存在 → 404「连接器不存在」；其它 → 500「更新失败」
- 特殊行为：审计 `connector_enabled`。

## 7.6 DELETE /api/server/admin/connectors/:id
- 鉴权：AdminSession+`connector:write`
- path 参数：`id`
- 成功响应 200：`{"ok":true}`
- 错误：不存在 → 404「连接器不存在」；其它 → 500「删除失败」
- 特殊行为：审计 `connector_delete`。
