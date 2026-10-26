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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * 部门（组）—— 金字塔组织架构（0017）。
 * parent_id 0 = 顶层；leader_id 引用 users.id（0 = 未设主管）。
 * 权限继承：授权给部门 X → X 及子部门成员可见；主管向上获得其部门子树授权。
 */
export const groups = pgTable(
  'groups',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    parentId: integer('parent_id').notNull().default(0),
    leaderId: integer('leader_id').notNull().default(0),
    description: text('description').notNull().default(''),
    /** 部门预算（已下线特性，仅保留列，重写不读写）。 */
    budgetMoney: doublePrecision('budget_money'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('groups_name_key').on(table.name),
    index('idx_groups_parent').on(table.parentId),
  ],
);

export type Group = typeof groups.$inferSelect;
export type NewGroup = typeof groups.$inferInsert;

/** 用户-部门多对多（PUT users/:id/department 接受 group_ids 数组）。 */
export const userGroups = pgTable(
  'user_groups',
  {
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: bigint('group_id', { mode: 'number' })
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.groupId] })],
);

export type UserGroup = typeof userGroups.$inferSelect;

/** 键值配置（全局 settings，唯一真源）。 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export type Setting = typeof settings.$inferSelect;
