import {
  bigint,
  bigserial,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * 统一应用模型（迁移 0053/0054/0055）。
 *
 * 旧的三组表（skills/skill_grants、shared_skills/shared_skill_grants、
 * agent_presets/agent_preset_grants）已被 0055 删除。技能与智能体现在共用：
 *
 *   apps          —— 长期身份（kind + app_id），承载归属、渠道、上架态、官方标记
 *   app_releases  —— 不可变版本快照（含归档字节），承载审核状态与质量标记
 *   app_grants    —— App 级授权（user/group，大小写不敏感）
 *
 * 语义权威：server/internal/serverstore/{apps,skills,shared_skills,
 * agent_presets,grants,distribution}.go。不要在此模型之外另建“技能表”。
 */

/** bytea（归档字节）；drizzle 无内建类型，用 customType 包一层。 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/** 应用种类：技能 / 智能体（本重写不实现 wasm_app 变体）。 */
export const APP_KIND = ['skill', 'agent'] as const;
export type AppKind = (typeof APP_KIND)[number];

/** 分发渠道：市场（全员可见）/ 组织（授权可见）。 */
export const APP_CHANNEL = ['market', 'org'] as const;
export type AppChannel = (typeof APP_CHANNEL)[number];

/** 审核状态机：pending → approved | rejected。 */
export const REVIEW_STATUS = ['pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUS)[number];

export const GRANTEE_TYPE = ['user', 'group'] as const;
export type GranteeType = (typeof GRANTEE_TYPE)[number];

export const apps = pgTable(
  'apps',
  {
    kind: text('kind').$type<AppKind>().notNull(),
    appId: text('app_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    /** 归属人（发布权、「我的」分区、下载豁免的唯一真源）。官方内容恒为空串。 */
    owner: text('owner').notNull().default(''),
    channel: text('channel').$type<AppChannel>().notNull(),
    /** 上架/下架：0 = 下架（只挡分发面，不删数据、不隐藏作者视图）。 */
    enabled: integer('enabled').notNull().default(1),
    /** 官方标记（蓝标 + 仅管理员可上传）；official=1 时 owner 恒为空。 */
    official: integer('official').notNull().default(0),
    purpose: text('purpose').notNull().default(''),
    dataSensitivity: text('data_sensitivity').notNull().default(''),
    configJson: text('config_json').notNull().default(''),
    currentReleaseId: bigint('current_release_id', { mode: 'number' })
      .notNull()
      .default(0),
    frozenAt: timestamp('frozen_at', { withTimezone: true, mode: 'date' }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.appId] }),
    index('idx_apps_kind_channel').on(table.kind, table.channel),
  ],
);

export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;

export const appReleases = pgTable(
  'app_releases',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').$type<AppKind>().notNull(),
    appId: text('app_id').notNull(),
    version: text('version').notNull(),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    changelog: text('changelog').notNull().default(''),
    category: text('category').notNull().default(''),
    /** 标签数组，库内以 JSON 字符串存储。 */
    tags: text('tags').notNull().default(''),
    /** 包内署名（不参与归属判断）。 */
    author: text('author').notNull().default(''),
    /** 上传账号（归属判断读 apps.owner，不读这里）。 */
    publisher: text('publisher').notNull().default(''),
    checksum: text('checksum').notNull().default(''),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    /** 归档字节（版本快照不可变；reject 时清空）。 */
    archive: bytea('archive'),
    status: text('status').$type<ReviewStatus>().notNull().default('pending'),
    reason: text('reason').notNull().default(''),
    quality: text('quality').notNull().default(''),
    downloads: bigint('downloads', { mode: 'number' }).notNull().default(0),
    calls: bigint('calls', { mode: 'number' }).notNull().default(0),
    configJson: text('config_json').notNull().default(''),
    assetsDir: text('assets_dir').notNull().default(''),
    /** 软删：版本号永久占位，不可复用。 */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('app_releases_kind_app_version_key').on(
      table.kind,
      table.appId,
      table.version,
    ),
    index('idx_app_releases_kind_status').on(table.kind, table.status),
  ],
);

export type AppRelease = typeof appReleases.$inferSelect;
export type NewAppRelease = typeof appReleases.$inferInsert;

/** App 级授权：严格默认拒绝（无行 = 不可见），大小写不敏感比较。 */
export const appGrants = pgTable(
  'app_grants',
  {
    kind: text('kind').$type<AppKind>().notNull(),
    appId: text('app_id').notNull(),
    granteeType: text('grantee_type').$type<GranteeType>().notNull(),
    grantee: text('grantee').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.kind, table.appId, table.granteeType, table.grantee],
    }),
    index('idx_app_grants_grantee').on(table.granteeType, table.grantee),
  ],
);

export type AppGrant = typeof appGrants.$inferSelect;
