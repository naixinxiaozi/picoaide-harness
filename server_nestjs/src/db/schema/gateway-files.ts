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
