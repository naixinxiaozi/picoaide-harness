import {
  bigserial,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * 月度报表订阅（0056 + 0082 重试退避）。
 * 周期生成上月用量汇总并推送到企业 webhook（钉钉/企微/飞书等）。
 */
export const reportSubscriptions = pgTable('report_subscriptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled').notNull().default(1),
  hookUrl: text('hook_url').notNull(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
  lastError: text('last_error').notNull().default(''),
  /** 待补期号（北京月 YYYYMM）；'' = 按「当前月的上一期」投递。 */
  pendingPeriod: text('pending_period').notNull().default(''),
  /** 连续失败次数（重试退避）。 */
  failStreak: integer('fail_streak').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export type ReportSubscription = typeof reportSubscriptions.$inferSelect;
export type NewReportSubscription = typeof reportSubscriptions.$inferInsert;
