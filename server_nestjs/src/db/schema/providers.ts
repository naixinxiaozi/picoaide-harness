import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * 上游协议：OpenAI 兼容（默认）/ Anthropic 兼容（/v1/messages 专用）/
 * both（同一上游同时提供两种协议）。与 Go 服务端 `admin.go` 的校验集合保持一致。
 */
export const PROVIDER_PROTOCOL = ['openai', 'anthropic', 'both'] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOL)[number];

export const gatewayProviders = pgTable(
  'gateway_providers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    /** AES-GCM 加密后的上游 API key（密钥不出服务端）。 */
    apiKeyEnc: text('api_key_enc').notNull(),
    /** 该 provider 关联的模型名 JSON 数组。 */
    models: text('models').notNull().default('[]'),
    enabled: integer('enabled').notNull().default(1),
    channel: text('channel').notNull().default(''),
    protocol: text('protocol')
      .$type<ProviderProtocol>()
      .notNull()
      .default('openai'),
  },
  (table) => [uniqueIndex('gateway_providers_name_key').on(table.name)],
);

export type GatewayProvider = typeof gatewayProviders.$inferSelect;
export type NewGatewayProvider = typeof gatewayProviders.$inferInsert;

export const models = pgTable(
  'models',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    providerId: bigint('provider_id', { mode: 'number' })
      .notNull()
      .references(() => gatewayProviders.id, { onDelete: 'cascade' }),
    displayName: text('display_name'),
    defaultParams: text('default_params').notNull().default('{}'),
    /** 输入价（元 / 百万 token）；NULL = 未定价。 */
    inputPricePer1m: doublePrecision('input_price_per_1m'),
    outputPricePer1m: doublePrecision('output_price_per_1m'),
    /** 峰谷折扣（0 < d < 1）；NULL = 无峰谷价。 */
    offpeakDiscount: doublePrecision('offpeak_discount'),
    /** 缓存命中输入价（元 / 百万 token）；NULL 回退输入价。 */
    cacheInputPricePer1m: doublePrecision('cache_input_price_per_1m'),
    /** 输入模态 JSON 数组（如 ["text","image"]）。 */
    inputModalities: text('input_modalities').notNull().default('["text"]'),
    /** 上游目录缺失标记（0080）：true = 同步发现目录缺失，保留行但不可路由。 */
    catalogMissing: boolean('catalog_missing').notNull().default(false),
  },
  (table) => [
    // 同名模型可挂多个 provider（failover）；唯一键 = (provider_id, name)。
    uniqueIndex('models_provider_name_key').on(table.providerId, table.name),
    index('idx_models_name').on(table.name),
  ],
);

export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
