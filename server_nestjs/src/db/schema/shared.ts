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
import { GRANTEE_TYPE, type GranteeType } from './skills';

/** 审核状态机：pending → approved | rejected。 */
export const REVIEW_STATUS = ['pending', 'approved', 'rejected'] as const;
export type ReviewStatus = (typeof REVIEW_STATUS)[number];

/** 共享技能（员工上传 → 管理员审核 → 授权可见，多版本并存，0034）。 */
export const sharedSkills = pgTable(
  'shared_skills',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    displayName: text('display_name').notNull().default(''),
    version: text('version').notNull(),
    description: text('description').notNull().default(''),
    author: text('author').notNull(),
    checksum: text('checksum').notNull().default(''),
    status: text('status').$type<ReviewStatus>().notNull().default('pending'),
    reason: text('reason').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('shared_skills_name_version_key').on(table.name, table.version),
    index('idx_shared_skills_name').on(table.name),
    index('idx_shared_skills_status').on(table.status),
  ],
);

export type SharedSkill = typeof sharedSkills.$inferSelect;
export type NewSharedSkill = typeof sharedSkills.$inferInsert;

/** 共享技能授权（同名多版本共享一个授权；作者自己始终可见）。 */
export const sharedSkillGrants = pgTable(
  'shared_skill_grants',
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

/** 共享 Agent 预设（员工上传 → 审核 → 授权，多版本并存，0035）。 */
export const agentPresets = pgTable(
  'agent_presets',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    displayName: text('display_name').notNull().default(''),
    version: text('version').notNull().default('1.0.0'),
    description: text('description').notNull().default(''),
    author: text('author').notNull(),
    checksum: text('checksum').notNull().default(''),
    status: text('status').$type<ReviewStatus>().notNull().default('pending'),
    reason: text('reason').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_presets_name_version_key').on(table.name, table.version),
    index('idx_agent_presets_name').on(table.name),
    index('idx_agent_presets_status').on(table.status),
  ],
);

export type AgentPreset = typeof agentPresets.$inferSelect;
export type NewAgentPreset = typeof agentPresets.$inferInsert;

/** Agent 预设授权（同名多版本共享一个授权）。 */
export const agentPresetGrants = pgTable(
  'agent_preset_grants',
  {
    presetName: text('preset_name').notNull(),
    granteeType: text('grantee_type').$type<GranteeType>().notNull(),
    grantee: text('grantee').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.presetName, table.granteeType, table.grantee],
    }),
  ],
);

export type AgentPresetGrant = typeof agentPresetGrants.$inferSelect;
