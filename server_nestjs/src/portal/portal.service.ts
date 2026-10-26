import { Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

export const RESERVED_NOTE =
  'enabled 与 landing_path 是保留字段(尚未生效):接口照常接受并原样回显,但当前没有任何消费方。要让门户下线请设 public=false;登录后落地页由角色默认分区决定。';

const RESERVED_FIELDS = ['enabled', 'landing_path'];

const PORTAL_KEYS = {
  enabled: 'portal.enabled',
  public: 'portal.public',
  subtitle: 'portal.subtitle',
  clientDownloadUrl: 'portal.client_download_url',
  clientDownloadLinux: 'portal.client_download_linux',
  clientDownloadMac: 'portal.client_download_mac',
  clientDownloadWin: 'portal.client_download_win',
  clientDownloadNote: 'portal.client_download_note',
  landingPath: 'portal.landing_path',
} as const;

export interface PortalConfig {
  enabled: boolean;
  public: boolean;
  subtitle: string;
  client_download_url?: string;
  client_download_linux: string;
  client_download_mac: string;
  client_download_win: string;
  client_download_note: string;
  landing_path: string;
}

export interface PortalResponse extends PortalConfig {
  reserved_fields: string[];
  reserved_note: string;
}

/** PUT 请求体：全部指针（null/缺省 = 保留现值）。 */
export interface PortalUpdate {
  enabled?: boolean | null;
  public?: boolean | null;
  subtitle?: string | null;
  client_download_url?: string | null;
  client_download_linux?: string | null;
  client_download_mac?: string | null;
  client_download_win?: string | null;
  client_download_note?: string | null;
  landing_path?: string | null;
}

/**
 * 门户配置（settings 键值对，与 Go portal/config.go 对齐）。
 */
@Injectable()
export class PortalService {
  constructor(private readonly settings: SettingsService) {}

  async loadConfig(): Promise<PortalConfig> {
    const m = await this.settings.getMany([
      PORTAL_KEYS.enabled,
      PORTAL_KEYS.public,
      PORTAL_KEYS.subtitle,
      PORTAL_KEYS.clientDownloadUrl,
      PORTAL_KEYS.clientDownloadLinux,
      PORTAL_KEYS.clientDownloadMac,
      PORTAL_KEYS.clientDownloadWin,
      PORTAL_KEYS.clientDownloadNote,
      PORTAL_KEYS.landingPath,
    ]);
    const cfg: PortalConfig = {
      enabled: m.get(PORTAL_KEYS.enabled) !== 'false',
      public: m.get(PORTAL_KEYS.public) !== 'false',
      subtitle: m.get(PORTAL_KEYS.subtitle) ?? '',
      client_download_linux: m.get(PORTAL_KEYS.clientDownloadLinux) ?? '',
      client_download_mac: m.get(PORTAL_KEYS.clientDownloadMac) ?? '',
      client_download_win: m.get(PORTAL_KEYS.clientDownloadWin) ?? '',
      client_download_note: m.get(PORTAL_KEYS.clientDownloadNote) ?? '',
      landing_path: m.get(PORTAL_KEYS.landingPath) ?? '',
    };
    const dlUrl = m.get(PORTAL_KEYS.clientDownloadUrl) ?? '';
    if (dlUrl) cfg.client_download_url = dlUrl;
    return cfg;
  }

  async saveConfig(update: PortalUpdate): Promise<void> {
    const boolFields: [keyof PortalUpdate, string][] = [
      ['enabled', PORTAL_KEYS.enabled],
      ['public', PORTAL_KEYS.public],
    ];
    for (const [field, key] of boolFields) {
      const v = update[field];
      if (v === null || v === undefined) continue;
      await this.settings.set(key, v ? 'true' : 'false');
    }
    const strFields: [keyof PortalUpdate, string][] = [
      ['subtitle', PORTAL_KEYS.subtitle],
      ['client_download_url', PORTAL_KEYS.clientDownloadUrl],
      ['client_download_linux', PORTAL_KEYS.clientDownloadLinux],
      ['client_download_mac', PORTAL_KEYS.clientDownloadMac],
      ['client_download_win', PORTAL_KEYS.clientDownloadWin],
      ['client_download_note', PORTAL_KEYS.clientDownloadNote],
      ['landing_path', PORTAL_KEYS.landingPath],
    ];
    for (const [field, key] of strFields) {
      const v = update[field];
      if (v === null || v === undefined) continue;
      await this.settings.set(key, v as string);
    }
  }

  response(cfg: PortalConfig): PortalResponse {
    return { ...cfg, reserved_fields: RESERVED_FIELDS, reserved_note: RESERVED_NOTE };
  }
}
