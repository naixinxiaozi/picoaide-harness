/**
 * Drizzle schema 汇总：re-export 全部表定义与类型。
 * 所有业务模块统一从这里导入表，保证单一真源。
 *
 * 注意：技能 / 共享技能 / 智能体预设 / 授权都走统一应用模型
 * （apps + app_releases + app_grants，迁移 0053/0055），没有独立的 skills 表。
 */
export * from './users';
export * from './groups';
export * from './providers';
export * from './usage';
export * from './balance';
export * from './apps';
export * from './connectors';
export * from './capabilities';
export * from './reports';
export * from './audit';
export * from './gateway-files';
export * from './telemetry';

// 全量表清单（drizzle-kit 依据此数组生成迁移，顺序无关）。
import { users, apiTokens } from './users';
import { groups, userGroups, settings } from './groups';
import { gatewayProviders, models } from './providers';
import { usage, usageDaily, usageMonthly } from './usage';
import {
  balanceLedger,
  balanceGrantItems,
  balanceGrants,
} from './balance';
import { apps, appReleases, appGrants } from './apps';
import { connectors } from './connectors';
import { capabilityLocks, modelConcurrencyStats } from './capabilities';
import { reportSubscriptions } from './reports';
import { auditLogs, adminSessions } from './audit';
import { gatewayFiles } from './gateway-files';
import {
  clientErrorReportingStatus,
  ldapSyncedUsers,
} from './telemetry';

export const schema = {
  users,
  apiTokens,
  groups,
  userGroups,
  settings,
  gatewayProviders,
  models,
  usage,
  usageDaily,
  usageMonthly,
  balanceLedger,
  balanceGrantItems,
  balanceGrants,
  apps,
  appReleases,
  appGrants,
  connectors,
  capabilityLocks,
  modelConcurrencyStats,
  reportSubscriptions,
  auditLogs,
  adminSessions,
  gatewayFiles,
  clientErrorReportingStatus,
  ldapSyncedUsers,
};

export type Schema = typeof schema;
