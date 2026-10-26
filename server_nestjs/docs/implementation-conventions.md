# server_nestjs 实现约定（子任务必读）

本文件是各业务模块实现的唯一约定真源。契约文档在 `docs/contract-0{1,2,3,4}-*.md`，
schema 字段名在 `src/db/schema/*.ts`。两端（服务端 + Nuxt web）都遵守这些约定。

## 1. 路由分层与守卫

- **客户端员工面** `/api/client/v2/*`：`@Controller('api/client/v2/...')` + 类级
  `@UseGuards(BearerAuthGuard)`；公开路由方法加 `@Public()`。
- **管理面** `/api/server/admin/*`：`@Controller('api/server/admin/...')` + 类级
  `@UseGuards(AdminAuthGuard, RbacGuard)`；公开路由（login/auth-methods）加
  `@Public()`；需要权限的路由方法加 `@Permissions('user:read', ...)`（权限字符串
  见 `src/common/rbac/permissions.ts`，23 个）。
- 需要当前主体用 `@CurrentUser()`（ClientPrincipal）或 `@CurrentAdmin()`（AdminPrincipal）。

## 2. 错误处理

- 一律 `throw new ApiError(code, message, httpStatus?)`，**不要** throw HttpException。
- code 取自 `src/common/errors/api-error.ts` 的 `ERROR_CODES`。全局过滤器已映射 HTTP 状态。
- 请求体校验**在服务层手动做**（全局 ValidationPipe 是 `whitelist:false`，不会裁剪）。
  精确文案以契约 md / Go 源码为准（如「请求体格式错误」「用户名或密码错误」）。

## 3. DB 访问

- 注入 `@Inject(DRIZZLE) private readonly db: Database`（`Database` 类型来自
  `src/db/database.module.ts`）。
- 用 drizzle 查询构建器 + `src/db/schema` 的表/列常量。字段是 **camelCase**（映射 snake_case 列）。
- 金额/价格列是 `doublePrecision`；user_id/group_id/provider_id 是 `bigint({mode:'number'})`。
- 聚合用 `sql<number>\`coalesce(sum(...)::float8, 0)\`` 后 `Number()` 化。

## 4. 通用工具

- 金额：`src/common/money.ts` → `quantizeMoney`（分位四舍五入，NaN/Inf→0）、`roundMoney`(2dp)、
  `formatMoney`、`roundMicro`(1e-6)。
- 时间：`src/common/time.ts` → `beijingDayStartUTC`/`beijingMonthStartUTC`/`beijingDayStr`/
  `beijingMonthStartStr`/`beijingMonthKey`/`rfc3339UTC`。北京口径 = 固定 +8h。
- 加密：`src/common/crypto/crypto.service.ts` → `sha256`/`hmacSha256`/`hashPassword`/`verifyPassword`/
  `encrypt`/`decrypt`(AES-GCM `enc:v1:` 前缀)/`randomHex`/`constantTimeEqual`。
- settings：`SettingsService`（全局）→ `get(key)`/`getMany(keys)`/`set(key,value)`/`authMinPasswordLength()`。
- 审计：`AuditService.log(username, action, detail)`（哈希链自动处理）。

## 5. 模块结构

每个域一个目录，含 `<name>.module.ts` + `<name>.service.ts` + `<name>.controller.ts`。
**不要改 `src/app.module.ts`**（接线由主线统一完成）。模块内部 imports 用到的其他模块
（如 UsersModule/AuditModule/SettingsModule/AuthModule 的 TokenService）。

## 6. 响应形状

JSON 一律 **snake_case**，与契约 md 逐字段对齐（含 `userJSON` 的 18 字段、usage 摘要 14 字段等）。
`userJSON` 序列化统一用 `UsersService.toUserJSON(user)`。

## 7. 硬约束

- 不新增 npm 依赖（已有：@nestjs/*、drizzle-orm、postgres、argon2、class-validator/transformer、rxjs、reflect-metadata）。
- Node v24、pnpm 11（`& node.exe pnpm.mjs run typecheck` 在 `server_nestjs/` 目录跑）。
- 不改 `src/db/schema/`（已冻结）；需要新表先和主线确认。
