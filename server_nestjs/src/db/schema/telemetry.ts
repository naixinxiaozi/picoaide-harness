import {
  bigint,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** 客户端错误上报状态（0068）：按用户一行，最新一次上报状态。 */
export const clientErrorReportingStatus = pgTable('client_error_reporting_status', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey(),
  /** idle | disabled | ready | failed | config_unavailable。 */
  state: text('state').notNull(),
  reason: text('reason').notNull().default(''),
  /** 只存裸主机名（可带端口），绝不落整条 DSN。 */
  dsnHost: text('dsn_host').notNull().default(''),
  level: text('level').notNull().default(''),
  release: text('release').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export type ClientErrorReportingStatus =
  typeof clientErrorReportingStatus.$inferSelect;

/** LDAP 全量同步用户台账（0060，2026-09 审计改为按用户名）：空组即回收。 */
export const ldapSyncedUsers = pgTable('ldap_synced_users', {
  username: text('username').primaryKey(),
  syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export type LdapSyncedUser = typeof ldapSyncedUsers.$inferSelect;
