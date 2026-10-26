import {
  bigint,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** usage 行类型：chat / embedding。 */
export const USAGE_KIND = ['chat', 'embedding'] as const;
export type UsageKind = (typeof USAGE_KIND)[number];

/**
 * LLM 调用计量主表（原库按月原生分区；重写为逻辑普通表，
 * 分区优化可用 raw SQL 迁移按需重加）。
 */
export const usage = pgTable(
  'usage',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    model: text('model').notNull(),
    promptTokens: bigint('prompt_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    kind: text('kind').$type<UsageKind>().notNull().default('chat'),
    /** 费用（元），记录时按模型定价与峰谷窗口折算（0022/0023）。 */
    cost: doublePrecision('cost').notNull().default(0),
    /** 缓存命中输入 token 数。 */
    cachePromptTokens: bigint('cache_prompt_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    /** true = 至少一侧 token 来自服务端按字节估算（0063）。 */
    estimated: boolean('estimated').notNull().default(false),
    /** 实际服务的 provider（0 = 未知/历史行）。 */
    providerId: bigint('provider_id', { mode: 'number' }).notNull().default(0),
    /** web_search 成功返回结果的次数（0085，按次计费）。 */
    searchRequests: bigint('search_requests', { mode: 'number' })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_usage_user_time').on(table.userId, table.createdAt),
    index('idx_usage_time').on(table.createdAt),
    index('idx_usage_model_time').on(table.model, table.createdAt),
    index('idx_usage_kind').on(table.kind),
  ],
);

export type Usage = typeof usage.$inferSelect;
export type NewUsage = typeof usage.$inferInsert;

/** 日账（永久保留，由账本任务从 usage 明细 UPSERT 生成）。 */
export const usageDaily = pgTable(
  'usage_daily',
  {
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    model: text('model').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    promptTokens: bigint('prompt_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cachePromptTokens: bigint('cache_prompt_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    requests: bigint('requests', { mode: 'number' }).notNull().default(0),
    cost: doublePrecision('cost').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.model, table.day] }),
    index('idx_usage_daily_day').on(table.day),
  ],
);

export type UsageDaily = typeof usageDaily.$inferSelect;

/** 月账（普通表，永久保留，由日账聚合生成）。 */
export const usageMonthly = pgTable(
  'usage_monthly',
  {
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    model: text('model').notNull(),
    /** 月初（YYYY-MM-01）。 */
    month: date('month', { mode: 'string' }).notNull(),
    promptTokens: bigint('prompt_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    completionTokens: bigint('completion_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cachePromptTokens: bigint('cache_prompt_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    requests: bigint('requests', { mode: 'number' }).notNull().default(0),
    cost: doublePrecision('cost').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.model, table.month] }),
    index('idx_usage_monthly_month').on(table.month),
  ],
);

export type UsageMonthly = typeof usageMonthly.$inferSelect;
