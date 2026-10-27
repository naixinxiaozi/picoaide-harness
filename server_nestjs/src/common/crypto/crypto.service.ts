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

  /**
   * 主密钥来源：文件 > ENV > 管理员密码派生（开发回退）。
   *
   * 与 Go 服务端 `internal/util/crypto.go` 的 `parseKey` 严格对齐：
   * master.key 文件里是**原始字节**（32 字节随机数），不是文本；16/24/32
   * 字节的密钥材料直接作为 AES key，**不能再做哈希**——哈希会得到另一把
   * 密钥，导致无法解密 Go 写入的 api_key_enc（表现为上游密钥解密失败、
   * provider 被跳过、对话 404）。
   */
  private loadMasterKey(): Buffer {
    const { masterKeyFile, masterKey, adminPassword } = this.config;

    if (masterKeyFile && existsSync(masterKeyFile)) {
      const raw = readFileSync(masterKeyFile);
      return parseMasterKey(raw, masterKeyFile);
    }
    if (masterKey) {
      return parseMasterKey(Buffer.from(masterKey, 'utf8'), 'MASTER_KEY');
    }

    this.logger.warn('未配置 master key，回退到管理员密码派生（仅开发）');
    return createHash('sha256').update(adminPassword ?? '').digest();
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

/**
 * 校验并返回 AES 主密钥（与 Go `util.parseKey` 同口径）。
 * 长度必须是 16/24/32 字节；不合法直接抛错（fail-loud），不做静默哈希回退，
 * 否则会与 Go 服务端产生不可察觉的密钥分叉。
 */
function parseMasterKey(material: Buffer, source: string): Buffer {
  if (material.length === 16 || material.length === 24 || material.length === 32) {
    return material;
  }
  throw new Error(`master key must be 16/24/32 bytes, got ${material.length} (${source})`);
}
