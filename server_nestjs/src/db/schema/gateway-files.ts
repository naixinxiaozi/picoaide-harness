import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * LLM 网关 Files API 直通的归属台账（0077 + 0078）。
 * 上传成功即写 (file_id, user_id, expires_at)；GET/DELETE 先查归属（不是自己的按 404）。
 */
export const gatewayFiles = pgTable(
  'gateway_files',
  {
    fileId: text('file_id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    /** 回收标记（0079）：非空表示已进入回收流程，避免并发重复回收。 */
    reapingAt: timestamp('reaping_at', { withTimezone: true, mode: 'date' }),
    /** 回收代数（0081）：每次回收尝试 +1，用于幂等对账。 */
    reapGen: bigint('reap_gen', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    index('idx_gateway_files_user_created').on(
      table.userId,
      table.createdAt,
    ),
    index('idx_gateway_files_expires').on(table.expiresAt),
  ],
);

export type GatewayFile = typeof gatewayFiles.$inferSelect;
export type NewGatewayFile = typeof gatewayFiles.$inferInsert;
