import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import * as argon2 from 'argon2';
import { readFileSync, existsSync } from 'fs';
import { CONFIG, type AppConfig } from '../../config/configuration';

const AES_ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const ENC_PREFIX = 'enc:v1:';

/**
 * 密码学服务：argon2id 口令哈希、AES-256-GCM 密钥封装、SHA-256。
 * 密钥与哈希算法口径与现有 Go server 对齐。
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private masterKey: Buffer = createHash('sha256')
    .update('picoaide-dev-key')
    .digest();

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    this.masterKey = this.loadMasterKey();
  }

  /** 主密钥来源：文件 > ENV 明文 > 管理员密码派生（开发回退）。 */
  private loadMasterKey(): Buffer {
    const { masterKeyFile, masterKey, adminPassword } = this.config;
    let material: string | null = null;

    if (masterKeyFile && existsSync(masterKeyFile)) {
      material = readFileSync(masterKeyFile, 'utf8').trim();
    } else if (masterKey) {
      material = masterKey;
    } else {
      this.logger.warn('未配置 master key，回退到管理员密码派生（仅开发）');
      material = adminPassword;
    }

    return createHash('sha256').update(material ?? '').digest();
  }

  /** AES-256-GCM 加密 → `enc:v1:<base64(iv|cipher|tag)>`。 */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(AES_ALGO, this.masterKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ENC_PREFIX + Buffer.concat([iv, enc, tag]).toString('base64');
  }

  /** 解密 `enc:v1:` 值；格式或密钥不符时抛错。 */
  decrypt(payload: string): string {
    if (!payload.startsWith(ENC_PREFIX)) {
      throw new Error('unsupported ciphertext format');
    }
    const buf = Buffer.from(payload.slice(ENC_PREFIX.length), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const enc = buf.subarray(IV_LEN, buf.length - TAG_LEN);
    const decipher = createDecipheriv(AES_ALGO, this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
      'utf8',
    );
  }

  sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  /** HMAC-SHA256（hex），供 CSRF token 签发/校验。 */
  hmacSha256(key: string, message: string): string {
    return createHmac('sha256', key).update(message).digest('hex');
  }

  /** 常量时间比较两个 hex/字符串。 */
  constantTimeEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  /** 生成随机 hex 字符串（会话 secret / csrf key）。 */
  randomHex(byteLen: number): string {
    return randomBytes(byteLen).toString('hex');
  }

  /** argon2id 哈希（与 Go argon2id 兼容的独立实现）。 */
  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
