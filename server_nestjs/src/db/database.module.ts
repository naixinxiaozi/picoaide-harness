import { Global, Module, type Provider } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env';
import * as schema from './schema';

/** Drizzle 实例注入 token。 */
export const DRIZZLE = Symbol('DRIZZLE');

/** 数据库类型别名：带完整 schema 的 drizzle 实例。 */
export type Database = PostgresJsDatabase<typeof schema>;

/** 底层 postgres-js 连接池注入 token（迁移/关闭需要直接访问）。 */
export const POSTGRES = Symbol('POSTGRES');

export type PostgresSql = ReturnType<typeof postgres>;

const databaseProvider: Provider = {
  provide: DRIZZLE,
  inject: [POSTGRES],
  useFactory: (sql: PostgresSql) => drizzle(sql, { schema }),
};

const postgresProvider: Provider = {
  provide: POSTGRES,
  useFactory: () => {
    const dsn = env(
      'PG_DSN',
      'postgres://picoaide:change-me@127.0.0.1:5432/picoaide',
    );
    // postgres-js 默认按需建连接；max 控制并发上限，避免压垮开发库。
    return postgres(dsn, { max: 10, idle_timeout: 20 });
  },
};

@Global()
@Module({
  providers: [postgresProvider, databaseProvider],
  exports: [DRIZZLE, POSTGRES],
})
export class DatabaseModule {}
