import {
  bigint,
  bigserial,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** 技能商城技能（管理员发布/规范化，bootstrap 建议清单来源）。 */
export const skills = pgTable(
  'skills',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    description: text('description').notNull().default(''),
    author: text('author').notNull().default(''),
    displayName: text('display_name').notNull().default(''),
    gitUrl: text('git_url').notNull(),
    gitRef: text('git_ref').notNull().default('main'),
    checksum: text('checksum').notNull().default(''),
    /** 下架置 0（不删行，bootstrap 建议清单过滤）。 */
    enabled: integer('enabled').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('skills_name_key').on(table.name)],
);

export type Skill = typeof skills.$inferSelect;
export type NewSkill = typeof skills.$inferInsert;

export const GRANTEE_TYPE = ['user', 'group'] as const;
export type GranteeType = (typeof GRANTEE_TYPE)[number];

/** 商城技能授权（审核 + 授权双门制，0016）：授权给 user 或 group。 */
export const skillGrants = pgTable(
  'skill_grants',
  {
    skillName: text('skill_name').notNull(),
    granteeType: text('grantee_type').$type<GranteeType>().notNull(),
    grantee: text('grantee').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.skillName, table.granteeType, table.grantee],
    }),
  ],
);

export type SkillGrant = typeof skillGrants.$inferSelect;
