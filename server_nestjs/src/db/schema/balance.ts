import {
  bigint,
  bigserial,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** 余额账本流水类型：发放/清零/调整/消费/回补。 */
export const LEDGER_KIND = [
  'grant',
  'reset',
  'adjust',
  'consume',
  'refund',
] as const;
export type LedgerKind = (typeof LEDGER_KIND)[number];

/**
 * 追加型余额账本（0062）—— 余额唯一账本真源。
 * 不变量：users.balance_money == SUM(balance_ledger.amount)（每用户）。
 */
export const balanceLedger = pgTable(
  'balance_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    kind: text('kind').$type<LedgerKind>().notNull(),
    /** 带符号：正=入账，负=出账（微元精度 1e-6）。 */
    amount: doublePrecision('amount').notNull(),
    /** 该笔之后的账户余额（微元）。 */
    balanceAfter: doublePrecision('balance_after').notNull(),
    reason: text('reason').notNull().default(''),
    /** 管理员用户名 / 'system'。 */
    actor: text('actor').notNull().default(''),
    /** consume/refund 关联 usage.id。 */
    usageId: bigint('usage_id', { mode: 'number' }),
    /** 发放批次（北京月 YYYYMM），非发放为 ''。 */
    month: text('month').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_balance_ledger_user').on(table.userId, table.id),
    index('idx_balance_ledger_usage')
      .on(table.usageId)
      // drizzle 部分索引需在迁移 SQL 补 WHERE usage_id IS NOT NULL；此处全列索引兜底。
      ,
  ],
);

export type BalanceLedger = typeof balanceLedger.$inferSelect;
export type NewBalanceLedger = typeof balanceLedger.$inferInsert;

/** 逐人·月发放幂等锚（0062）：新入职/漏发/重新启用员工被下一轮自动补齐。 */
export const balanceGrantItems = pgTable(
  'balance_grant_items',
  {
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    /** 北京月 YYYYMM。 */
    month: text('month').notNull(),
    amount: doublePrecision('amount').notNull(),
    mode: text('mode').notNull().default('add'),
    actor: text('actor').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.month] })],
);

export type BalanceGrantItem = typeof balanceGrantItems.$inferSelect;

/** 月度发放批次（旧「每北京月一条全体 UPDATE」锚，0061；逐人锚在 balance_grant_items）。 */
export const balanceGrants = pgTable('balance_grants', {
  month: text('month').primaryKey(),
  mode: text('mode').notNull(),
  amount: doublePrecision('amount').notNull(),
  affected: integer('affected').notNull().default(0),
  actor: text('actor').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export type BalanceGrant = typeof balanceGrants.$inferSelect;
