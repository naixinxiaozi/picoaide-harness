import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, lt } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { DRIZZLE, type Database } from '../db/database.module';
import { CryptoService } from '../common/crypto/crypto.service';
import { apiTokens } from '../db/schema';

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * 客户端 API token 服务：只存 SHA-256 哈希，90 天有效期（与 Go token.go 对齐）。
 */
@Injectable()
export class TokenService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly crypto: CryptoService,
  ) {}

  /** 签发 90 天 token；登录时顺带清扫一批过期行（有界，防表无界增长）。 */
  async issueToken(userId: number): Promise<string> {
    const expired = await this.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(lt(apiTokens.expiresAt, new Date()))
      .limit(200);
    if (expired.length) {
      await this.db
        .delete(apiTokens)
        .where(
          inArray(
            apiTokens.id,
            expired.map((e) => e.id),
          ),
        );
    }

    const raw = randomBytes(32).toString('base64url');
    await this.db.insert(apiTokens).values({
      userId,
      tokenHash: this.crypto.sha256(raw),
      name: 'desktop',
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    });
    return raw;
  }

  /** 按明文 token 吊销（登出）。 */
  async revokeToken(raw: string): Promise<void> {
    if (!raw) return;
    await this.db
      .update(apiTokens)
      .set({ revoked: 1 })
      .where(eq(apiTokens.tokenHash, this.crypto.sha256(raw)));
  }

  /** 吊销某用户全部 token（改密/禁用/删除后）。 */
  async revokeAllForUser(userId: number): Promise<void> {
    await this.db
      .update(apiTokens)
      .set({ revoked: 1 })
      .where(eq(apiTokens.userId, userId));
  }
}
