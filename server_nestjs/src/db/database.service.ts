import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { POSTGRES, type PostgresSql } from './database.module';

/** 负责底层连接池生命周期（应用关闭时优雅释放）。 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  constructor(@Inject(POSTGRES) private readonly sql: PostgresSql) {}

  async onModuleDestroy(): Promise<void> {
    await this.sql.end();
  }

  /** 供迁移/健康检查复用：执行任意 SQL，返回行数组。 */
  async query<T = Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.sql.unsafe(text, values as never)) as T[];
  }
}
