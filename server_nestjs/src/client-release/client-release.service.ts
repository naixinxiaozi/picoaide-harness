import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { ChannelService } from '../channel/channel.service';

const CLIENT_RELEASE_DIR_ENV = 'PICOAI_CLIENT_RELEASE_DIR';
const DEFAULT_CLIENT_RELEASE_DIR = '/opt/picoaide/client';
const MANIFEST_FILE = 'CLIENT-RELEASE.json';

export const ORIGIN_UNAVAILABLE_REASON =
  'server origin is not https; set PICOAI_PUBLIC_BASE_URL';

const ALLOWED_ASSET_EXTS = [
  '.dmg',
  '.exe',
  '.appimage',
  '.deb',
  '.zip',
  '.tar.gz',
  '.msi',
  '.pkg',
];

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.appimage': 'application/vnd.appimage',
  '.deb': 'application/vnd.debian.binary-package',
  '.zip': 'application/zip',
  '.tar.gz': 'application/gzip',
  '.msi': 'application/x-msi',
  '.pkg': 'application/vnd.apple.installer+xml',
};

interface ReleaseAsset {
  file: string;
  sha256: string;
  size: number;
}
interface ReleaseInfo {
  schema: number;
  channel_id: string;
  client: { version: string; assets: Record<string, ReleaseAsset> };
}

export interface Origin {
  base: string;
  reason: string;
}

/** manifest 请求上下文（来自 HTTP 请求头）。 */
export interface OriginContext {
  host: string;
  forwardedProto: string | undefined;
  tls: boolean;
}

/** 服务端版本（诊断用；与 Go BuildVersion 对应，重写用 env 注入）。 */
export function serverVersion(): string {
  return process.env.SERVER_VERSION ?? 'dev';
}

/**
 * 客户端安装包下发（与 Go clientrelease 对齐）：
 * 清单（/updates/manifest）+ 安装包静态下载（/updates/client/*file）。
 */
@Injectable()
export class ClientReleaseService {
  private readonly dir: string;

  constructor(
    private readonly settings: SettingsService,
    private readonly channel: ChannelService,
  ) {
    this.dir = process.env[CLIENT_RELEASE_DIR_ENV] || DEFAULT_CLIENT_RELEASE_DIR;
  }

  channelId(): string {
    return this.channel.channelId();
  }

  loadInfo(): ReleaseInfo | null {
    const file = path.join(this.dir, MANIFEST_FILE);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const info = JSON.parse(raw) as ReleaseInfo;
      if (!info.client || typeof info.client.version !== 'string' || !info.client.version) {
        return null;
      }
      return info;
    } catch {
      return null;
    }
  }

  async manifest(ctx: OriginContext): Promise<Record<string, unknown>> {
    const resp: Record<string, unknown> = {
      schema: 1,
      channel_id: this.channelId(),
      server: { version: serverVersion() },
    };
    const info = this.loadInfo();
    const origin = await this.resolveOrigin(ctx);
    if (!info) return resp;
    if (!origin.base) {
      resp['client_unavailable'] = origin.reason;
      return resp;
    }
    const assets: Record<string, { url: string; sha256: string; size: number }> = {};
    for (const [platform, a] of Object.entries(info.client.assets ?? {})) {
      if (!a || !a.file) continue;
      assets[platform] = {
        url: origin.base + '/updates/client/' + a.file,
        sha256: a.sha256 ?? '',
        size: a.size ?? 0,
      };
    }
    resp['client'] = { version: info.client.version, assets };
    return resp;
  }

  /**
   * 解析对外 origin：env → settings server.base_url → X-Forwarded-Proto/TLS → 回环 http。
   */
  async resolveOrigin(ctx: OriginContext): Promise<Origin> {
    const envBase = (process.env.PICOAI_PUBLIC_BASE_URL ?? '').trim();
    if (envBase) {
      const norm = normalizeBaseURL(envBase);
      if (!norm) return { base: '', reason: `invalid PICOAI_PUBLIC_BASE_URL` };
      if (!isSecureBase(norm)) {
        return { base: '', reason: 'PICOAI_PUBLIC_BASE_URL must be https' };
      }
      return { base: norm, reason: '' };
    }

    const configured = (await this.settings.get('server.base_url'))?.trim() ?? '';
    if (configured) {
      const norm = normalizeBaseURL(configured);
      if (norm && isSecureBase(norm)) return { base: norm, reason: '' };
      // 配置了但非法/非 https：忽略（不打印值，Go 侧 warn 只记日志）。
    }

    const host = ctx.host;
    if (!host) return { base: '', reason: ORIGIN_UNAVAILABLE_REASON };
    if (forwardedProtoIsHttps(ctx.forwardedProto) || ctx.tls) {
      return { base: 'https://' + host, reason: '' };
    }
    if (isLoopbackHost(host)) return { base: 'http://' + host, reason: '' };
    return { base: '', reason: ORIGIN_UNAVAILABLE_REASON };
  }

  /** 安装包落盘绝对路径（非法文件名/非普通文件返回 ''）。 */
  assetPath(file: string): string {
    if (!assetNameOK(file) || !allowedAssetName(file)) return '';
    const full = path.join(this.dir, file);
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile()) return '';
    } catch {
      return '';
    }
    return full;
  }

  assetContentType(file: string): string {
    const lower = file.toLowerCase();
    for (const [ext, ct] of Object.entries(ASSET_CONTENT_TYPES)) {
      if (lower.endsWith(ext)) return ct;
    }
    return 'application/octet-stream';
  }

  contentDisposition(file: string): string {
    const cleaned = file.replace(/[\u0000-\u001f\u007f]/g, '');
    const quoted = '"' + cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    if (/^[\x20-\x7e]+$/.test(cleaned)) {
      return 'attachment; filename=' + quoted;
    }
    return 'attachment; filename=' + quoted + "; filename*=UTF-8''" + encodeURIComponent(cleaned);
  }
}

function normalizeBaseURL(raw: string): string | null {
  if (raw.includes('?') || raw.includes('#')) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!u.host || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  if (u.username || u.password) return null;
  return raw.replace(/\/+$/, '');
}

function isSecureBase(base: string): boolean {
  const u = new URL(base);
  if (u.protocol === 'https:') return true;
  return isLoopbackHostname(u.hostname);
}

function isLoopbackHost(host: string): boolean {
  let hostname = host;
  try {
    hostname = new URL('http://' + host).hostname;
  } catch {
    // ignore, fall through with raw
  }
  return isLoopbackHostname(hostname);
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

function forwardedProtoIsHttps(raw: string | undefined): boolean {
  if (!raw) return false;
  const first = raw.split(',')[0].trim().toLowerCase();
  return first === 'https';
}

function assetNameOK(name: string): boolean {
  if (!name) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes('..')) return false;
  return true;
}

function allowedAssetName(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_ASSET_EXTS.some((ext) => lower.endsWith(ext));
}
