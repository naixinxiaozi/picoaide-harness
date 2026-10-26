import {
  date,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** 能力锁定（0050）：把技能/智能体标记为「员工不可上传分享」。 */
export const capabilityLocks = pgTable(
  'capability_locks',
  {
    kind: text('kind').notNull(), // 'skill' | 'agent'
    name: text('name').notNull(),
    reason: text('reason').notNull().default(''),
    lockedBy: text('locked_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.kind, table.name] })],
);

export type CapabilityLock = typeof capabilityLocks.$inferSelect;

/** 按模型并发峰值统计（0049，服务器信息指标）。 */
export const modelConcurrencyStats = pgTable(
  'model_concurrency_stats',
  {
    model: text('model').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    maxConcurrency: integer('max_concurrency').notNull().default(0),
    peakAt: timestamp('peak_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [primaryKey({ columns: [table.model, table.day] })],
);

export type ModelConcurrencyStat = typeof modelConcurrencyStats.$inferSelect;
