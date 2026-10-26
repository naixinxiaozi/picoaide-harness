import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { CONFIG, type AppConfig } from '../config/configuration';
import { CryptoService } from '../common/crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { users } from '../db/schema';

/**
 * 引导管理员（对齐 Go `serverauth.EnsureBootstrapAdmin`）。
 *
 * 仅在「库里还没有任何 super_admin」时创建 `BOOTSTRAP_ADMIN`，
 * 密码取 `PICOAI_ADMIN_PASSWORD`（缺失即失败，绝不静默生成/打印）。
 * 用户名已存在但不是超管时同样失败，避免把普通账号静默提权。
 */
@Injectable()
export class BootstrapAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BootstrapAdminService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(CONFIG) private readonly cfg: AppConfig,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const username = this.cfg.bootstrapAdmin.trim();
    if (!username) return; // 未配置引导管理员：不自动建号

    const [superAdmin] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'super_admin'))
      .limit(1);
    if (superAdmin) return; // 已有超管，忽略

    const password = this.cfg.adminPassword;
    if (!password) {
      throw new Error(
        `PICOAI_ADMIN_PASSWORD environment variable is required to bootstrap admin "${username}"`,
      );
    }
    const minLength = await this.settings.authMinPasswordLength();
    if ([...password].length < minLength) {
      throw new Error(
        `PICOAI_ADMIN_PASSWORD must be at least ${minLength} characters`,
      );
    }
    const [sameName] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .limit(1);
    if (sameName) {
      throw new Error(
        'bootstrap admin username already exists but is not an admin',
      );
    }

    const hash = await this.crypto.hashPassword(password);
    await this.db.insert(users).values({
      username,
      passwordHash: hash,
      source: 'local',
      status: 1,
      isAdmin: 1,
      role: 'super_admin',
      balanceMoney: 0,
    });
    this.logger.log(`created bootstrap admin "${username}"`);
  }
}
