import { Inject, Injectable } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { CryptoService } from '../common/crypto/crypto.service';
import { rfc3339UTC } from '../common/time';
import { auditLogs } from '../db/schema';

/**
 * 审计日志服务（敏感操作留痕 + 哈希链防篡改 0048）。
 * hash = sha256(prev_hash | username | action | detail | created_at)。
 * created_at 用 RFC3339 秒精度 UTC 字符串（与 Go time.RFC3339 口径一致）。
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly crypto: CryptoService,
  ) {}

  async log(username: string, action: string, detail = ''): Promise<void> {
    const [last] = await this.db
      .select({ hash: auditLogs.hash })
      .from(auditLogs)
      .orderBy(desc(auditLogs.id))
      .limit(1);
    const prevHash = last?.hash ?? '';
    const createdAt = rfc3339UTC(new Date());
    const payload = [prevHash, username, action, detail, createdAt].join('|');
    const hash = this.crypto.sha256(payload);
    await this.db.insert(auditLogs).values({
      username,
      action,
      detail,
      prevHash,
      hash,
      createdAt: new Date(createdAt),
    });
  }
}
