import {
  bigint,
  bigserial,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * 审计日志（敏感操作留痕 + 哈希链防篡改 0048）。
 * hash = sha256(prev_hash | username | action | detail | created_at)。
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    username: text('username').notNull(),
    action: text('action').notNull(),
    detail: text('detail').notNull().default(''),
    prevHash: text('prev_hash').notNull().default(''),
    hash: text('hash').notNull().default(''),
    /** 关联应用（可空）；技能/智能体相关审计写入 kind-appid 之外的标识时使用。 */
    appId: text('app_id'),
    /** 哈希链版本（0048 首版为 1）。 */
    hashVersion: integer('hash_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_audit_created_at').on(table.createdAt),
    index('idx_audit_action').on(table.action),
    index('idx_audit_username').on(table.username),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

/**
 * 管理会话（session + CSRF）。
 * id = 内部主键；secret_hash = cookie 值 SHA-256（只存哈希，0066）。
 */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: text('id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrfKey: text('csrf_key').notNull(),
    secretHash: text('secret_hash').notNull(),
    /** 12h 硬上限 + 60min 空闲滑动到期（0046）。 */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' })
      .notNull(),
  },
  (table) => [
    index('idx_admin_sessions_user').on(table.userId),
    index('idx_admin_sessions_expires').on(table.expiresAt),
  ],
);

export type AdminSession = typeof adminSessions.$inferSelect;
