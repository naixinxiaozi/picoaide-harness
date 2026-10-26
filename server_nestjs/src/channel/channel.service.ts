import * as fs from 'node:fs';
import * as path from 'node:path';
import { Injectable } from '@nestjs/common';

const CHANNEL_DIR_ENV = 'PICOAI_CHANNEL_DIR';
const DEFAULT_CHANNEL_DIR = '/opt/picoaide/channel';
const MAX_CONFIG_BYTES = 64 * 1024;

export const LOGO_URL_PATH = '/api/client/v2/channel/logo';
export const LOGO_DARK_URL_PATH = '/api/client/v2/channel/logo-dark';
export const FAVICON_URL_PATH = '/api/client/v2/channel/favicon';

export const ASSET_NO_SNIFF = 'nosniff';
export const ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const MAX_CHECKED_SVG_BYTES = 1 << 20;

interface ChannelConfig {
  schema: number;
  channel_id: string;
  identity: { display_name: string; short_name: string; tagline: string; title: string };
  copy: {
    login_display_name: string;
    login_tagline: string;
    login_welcome: string;
    client_display_name: string;
    client_tagline: string;
    portal_welcome: string;
  };
  assets: { logo: string; logo_dark: string; favicon: string; accent: string };
  desktop: { deep_link_scheme: string; app_origin_scheme: string; platforms: string[] };
}

const SVG_SCRIPT_SIGNATURES: { name: string; re: RegExp }[] = [
  { name: 'script-element', re: /<\s*script[\s/>]/i },
  { name: 'event-handler-attribute', re: /(?:^|[\s"'/<>])on[a-z]+\s*=/i },
  { name: 'javascript-url', re: /java\s*script\s*:/i },
  { name: 'foreign-object-element', re: /<\s*foreignobject[\s/>]/i },
  {
    name: 'external-use-href',
    re: /<\s*use[\s/>][^>]*(?:xlink:)?href\s*=\s*["']?\s*(?:https?:)?\/\//i,
  },
  { name: 'iframe-element', re: /<\s*iframe[\s/>]/i },
  { name: 'embed-element', re: /<\s*embed[\s/>]/i },
  {
    name: 'animate-href-attribute',
    re: /<\s*animate[\s/>][^>]*attributename\s*=\s*["']?\s*href/i,
  },
];

const NUMERIC_CHAR_REF = /&#(?:[xX]([0-9a-fA-F]{1,6})|([0-9]{1,7}));/g;

function decodeNumericCharRefs(s: string): string {
  if (!s.includes('&#')) return s;
  return s.replace(NUMERIC_CHAR_REF, (m, hex: string | undefined, dec: string | undefined) => {
    const code = hex ? parseInt(hex, 16) : parseInt(dec!, 10);
    if (Number.isNaN(code) || code <= 0 || code > 0x10ffff) return m;
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

function fallback(): ChannelConfig {
  return {
    schema: 1,
    channel_id: 'official',
    identity: { display_name: 'Harness', short_name: 'Harness', tagline: '', title: 'Harness' },
    copy: {
      login_display_name: 'Harness',
      login_tagline: '',
      login_welcome: '',
      client_display_name: 'Harness',
      client_tagline: '',
      portal_welcome: '',
    },
    assets: { logo: '', logo_dark: '', favicon: '', accent: '#2563eb' },
    desktop: { deep_link_scheme: '', app_origin_scheme: '', platforms: [] },
  };
}

/**
 * 渠道内容（channel.json）加载与员工面渠道素材下发（与 Go channel 对齐）。
 */
@Injectable()
export class ChannelService {
  private readonly dir: string;
  private cached: ChannelConfig | null = null;

  constructor() {
    this.dir = process.env[CHANNEL_DIR_ENV] || DEFAULT_CHANNEL_DIR;
  }

  channelId(): string {
    return this.config().channel_id;
  }

  config(): ChannelConfig {
    if (this.cached) return this.cached;
    this.cached = this.load();
    return this.cached;
  }

  private load(): ChannelConfig {
    const cfg = fallback();
    const file = path.join(this.dir, 'channel.json');
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return cfg;
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ChannelConfig>;
      this.applyDefaults(cfg, parsed);
    } catch {
      // 解析失败/缺失 → fallback
    }
    return cfg;
  }

  private applyDefaults(cfg: ChannelConfig, p: Partial<ChannelConfig>): void {
    if (p.channel_id) cfg.channel_id = p.channel_id;
    if (p.identity) {
      cfg.identity = { ...cfg.identity, ...p.identity };
    }
    if (p.copy) {
      cfg.copy = { ...cfg.copy, ...p.copy };
    }
    if (p.assets) {
      cfg.assets = { ...cfg.assets, ...p.assets };
    }
    if (p.desktop) {
      cfg.desktop = { ...cfg.desktop, ...p.desktop };
    }
    // 缺省回填
    if (!cfg.identity.title) cfg.identity.title = cfg.identity.display_name;
    if (!cfg.copy.login_display_name) cfg.copy.login_display_name = cfg.identity.short_name;
    if (!cfg.copy.client_display_name) cfg.copy.client_display_name = cfg.identity.display_name;
    if (!cfg.assets.accent) cfg.assets.accent = '#2563eb';
  }

  buildResponse(): Record<string, unknown> {
    const cfg = this.config();
    const logoUrl = this.logoPath() ? LOGO_URL_PATH : '';
    const darkUrl = this.logoDarkPath() ? LOGO_DARK_URL_PATH : '';
    const faviconUrl = this.faviconPath() ? FAVICON_URL_PATH : '';

    const login: Record<string, unknown> = { display_name: cfg.copy.login_display_name };
    if (cfg.copy.login_tagline) login.tagline = cfg.copy.login_tagline;
    if (cfg.copy.login_welcome) login.welcome = cfg.copy.login_welcome;
    if (logoUrl) login.logo_url = logoUrl;
    if (darkUrl) login.logo_url_dark = darkUrl;

    const client: Record<string, unknown> = { display_name: cfg.copy.client_display_name };
    if (cfg.copy.client_tagline) client.tagline = cfg.copy.client_tagline;
    if (logoUrl) client.logo_url = logoUrl;

    const resp: Record<string, unknown> = {
      channel_id: cfg.channel_id,
      title: cfg.identity.title,
      login,
      client,
    };
    if (faviconUrl) resp.favicon_url = faviconUrl;
    if (cfg.assets.accent) resp.accent = cfg.assets.accent;
    return resp;
  }

  /** 素材落盘绝对路径（未配置/非法/非普通文件 → ''）。 */
  private assetPath(name: string): string {
    if (!name || name.includes('/') || name.includes('\\')) return '';
    const full = path.join(this.dir, name);
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile()) return '';
    } catch {
      return '';
    }
    return full;
  }

  logoPath(): string {
    const cfg = this.config();
    return this.assetPath(cfg.assets.logo);
  }

  logoDarkPath(): string {
    const cfg = this.config();
    return this.assetPath(cfg.assets.logo_dark);
  }

  faviconPath(): string {
    const cfg = this.config();
    return this.assetPath(cfg.assets.favicon);
  }

  /** SVG 脚本防护：返回拒绝原因（空串 = 放行）。 */
  async checkAsset(file: string): Promise<string> {
    if (!file.toLowerCase().endsWith('.svg')) return '';
    const fd = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_CHECKED_SVG_BYTES + 1);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_CHECKED_SVG_BYTES) return '';
      const decoded = decodeNumericCharRefs(buf.subarray(0, bytesRead).toString('utf8'));
      for (const sig of SVG_SCRIPT_SIGNATURES) {
        if (sig.re.test(decoded)) return `svg contains ${sig.name}`;
      }
      return '';
    } catch {
      return '';
    } finally {
      await fd.close().catch(() => undefined);
    }
  }
}
