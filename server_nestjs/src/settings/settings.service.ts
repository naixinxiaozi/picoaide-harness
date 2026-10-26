import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { settings } from '../db/schema';

/** 密码最小长度 settings 键（管理面可配，默认 10）。 */
export const AUTH_MIN_PASSWORD_LENGTH_KEY = 'auth.min_password_length';

/**
 * 全局 settings（键值对）读取/写入服务。
 */
@Injectable()
export class SettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async get(key: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);
    return row?.value ?? null;
  }

  async getMany(keys: string[]): Promise<Map<string, string>> {
    const rows = await this.db
      .select()
      .from(settings)
      .where(inArray(settings.key, keys));
    return new Map(rows.map((r) => [r.key, r.value ?? '']));
  }

  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  /** 密码最小长度：缺失/非法（非 8~64 整数）回落默认 10。 */
  async authMinPasswordLength(): Promise<number> {
    const v = await this.get(AUTH_MIN_PASSWORD_LENGTH_KEY);
    if (!v) return 10;
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 8 || n > 64) return 10;
    return n;
  }
}
