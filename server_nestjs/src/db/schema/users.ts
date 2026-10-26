import {
  bigint,
  bigserial,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** 用户来源：本地 / LDAP / OIDC。 */
export const USER_SOURCE = ['local', 'ldap', 'oidc'] as const;
export type UserSource = (typeof USER_SOURCE)[number];

/** 角色：超级管理员 / 审计员 / 普通员工（0046 RBAC）。 */
export const USER_ROLE = ['super_admin', 'auditor', 'user'] as const;
export type UserRole = (typeof USER_ROLE)[number];

/** 账号状态：1 = 启用，0 = 禁用。 */
export const USER_STATUS = [1, 0] as const;
export type UserStatus = (typeof USER_STATUS)[number];

export const users = pgTable(
  'users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    username: text('username').notNull(),
    displayName: text('display_name'),
    email: text('email'),
    passwordHash: text('password_hash'),
    source: text('source')
      .$type<UserSource>()
      .notNull()
      .default('local'),
    /** 历史列，0046 起改用 role；保留以便存量数据兼容。 */
    isAdmin: integer('is_admin').notNull().default(0),
    status: integer('status').$type<UserStatus>().notNull().default(1),
    /** 员工余额（元，存量）—— 员工唯一可花的钱（0061）。 */
    balanceMoney: doublePrecision('balance_money').notNull().default(0),
    /** 余额账户开通时点（首次入账置位，0062）。 */
    balanceActivatedAt: timestamp('balance_activated_at', {
      withTimezone: true,
      mode: 'date',
    }),
    role: text('role').$type<UserRole>().notNull().default('user'),
    /** 已下线：员工 token 配额（列保留不读写，0021）。 */
    quotaTokens: bigint('quota_tokens', { mode: 'number' }),
    /** 已下线：员工金额配额（列保留不读写，0022）。 */
    quotaMoney: doublePrecision('quota_money'),
    /** 外部身份绑定：IdP 主体标识（OIDC sub / LDAP DN，0067）。 */
    externalId: text('external_id').notNull().default(''),
    externalSource: text('external_source').notNull().default(''),
    /** 管理员重置密码后置 1，下次登录强制改密（0057）。 */
    passwordMustChange: integer('password_must_change').notNull().default(0),
    /** 上次改密时间（NULL = 从未改密，0057）。 */
    passwordChangedAt: timestamp('password_changed_at', {
      withTimezone: true,
      mode: 'date',
    }),
    /** MFA 列（0057/0064）—— 本次重写暂不实现 TOTP，列保留 schema 兼容。 */
    totpSecret: text('totp_secret').notNull().default(''),
    totpEnabled: integer('totp_enabled').notNull().default(0),
    lastTotpStep: bigint('last_totp_step', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // 用户名唯一。原库 NOCASE（大小写不敏感，0061）在服务层用「写入/查询前
    // 统一 lowercase 用户名」实现等价语义，避免依赖 PG 排序规则差异。
    uniqueIndex('users_username_key').on(table.username),
    index('idx_users_status').on(table.status),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 只存 SHA-256 哈希，绝不存明文 token。 */
    tokenHash: text('token_hash').notNull(),
    name: text('name').notNull().default('desktop'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    revoked: integer('revoked').notNull().default(0),
  },
  (table) => [
    uniqueIndex('api_tokens_token_hash_key').on(table.tokenHash),
    index('idx_tokens_user').on(table.userId),
  ],
);

export type ApiToken = typeof apiTokens.$inferSelect;
