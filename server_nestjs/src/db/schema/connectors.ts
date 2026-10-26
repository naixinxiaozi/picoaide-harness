import {
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** 连接器认证模式（0083 新增 auto = 端点自述授权）。 */
export const CONNECTOR_AUTH_MODE = [
  'oauth',
  'device',
  'token',
  'server-side',
  'auto',
] as const;
export type ConnectorAuthMode = (typeof CONNECTOR_AUTH_MODE)[number];

/**
 * 连接器目录（0042）—— 服务端唯一目录源，经 bootstrap 下发 connectors[]。
 */
export const connectors = pgTable('connectors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  authMode: text('auth_mode').$type<ConnectorAuthMode>().notNull(),
  /** JSON：认证配置 + token 字段 + MCP 服务器。 */
  definition: text('definition').notNull(),
  /** 下架开关（0 = bootstrap 不下发，客户端隐藏）。 */
  enabled: integer('enabled').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
});

export type Connector = typeof connectors.$inferSelect;
export type NewConnector = typeof connectors.$inferInsert;
