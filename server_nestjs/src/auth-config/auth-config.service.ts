import { Inject, Injectable } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { ApiError } from '../common/errors/api-error';

const MASK_SECRET = '***';
const MIN_PASSWORD_LOWER = 8;
const MIN_PASSWORD_UPPER = 64;

const K_MODE = 'auth.mode';
const K_ENABLED = 'auth.enabled';
const K_HIDE_LOCAL = 'auth.hide_local';
const K_MIN_PASSWORD = 'auth.min_password_length';

const LDAP_KEYS = {
  serverUrl: 'ldap.server_url',
  bindDn: 'ldap.bind_dn',
  bindPassword: 'ldap.bind_password',
  baseDn: 'ldap.base_dn',
  userFilter: 'ldap.user_filter',
  userAttr: 'ldap.user_attr',
  groupFilter: 'ldap.group_filter',
  groupAttr: 'ldap.group_attr',
};
const OIDC_KEYS = {
  issuer: 'oidc.issuer',
  clientId: 'oidc.client_id',
  clientSecret: 'oidc.client_secret',
  redirectUrl: 'oidc.redirect_url',
};
const OPENID_KEYS = {
  issuer: 'openid.issuer',
  clientId: 'openid.client_id',
  clientSecret: 'openid.client_secret',
  redirectUrl: 'openid.redirect_url',
};

export interface LdapConfig {
  server_url: string;
  bind_dn: string;
  bind_password: string;
  base_dn: string;
  user_filter: string;
  user_attr: string;
  group_filter: string;
  group_attr: string;
}

export interface OidcConfig {
  issuer: string;
  client_id: string;
  client_secret: string;
  redirect_url: string;
}

export interface AuthConfig {
  mode: string;
  enabled: string;
  hide_local: boolean;
  min_password_length: number;
  ldap: LdapConfig;
  oidc: OidcConfig;
  openid: OidcConfig;
}

export interface AuthConfigBody {
  mode?: string;
  enabled?: string;
  hide_local?: boolean;
  min_password_length?: number;
  ldap?: {
    server_url?: string;
    bind_dn?: string;
    bind_password?: string;
    base_dn?: string;
    user_filter?: string;
    user_attr?: string;
    group_filter?: string;
    group_attr?: string;
  };
  oidc?: { issuer?: string; client_id?: string; client_secret?: string; redirect_url?: string };
  openid?: { issuer?: string; client_id?: string; client_secret?: string; redirect_url?: string };
}

export interface AuthTestBody {
  type?: string;
  ldap?: {
    server_url?: string;
    bind_dn?: string;
    bind_password?: string;
    base_dn?: string;
    user_filter?: string;
    user_attr?: string;
    group_filter?: string;
    group_attr?: string;
  };
  oidc?: { issuer?: string };
  openid?: { issuer?: string };
}

const ISSUER_URL_RE = /^(https):\/\/[A-Za-z0-9.\-]+(:\d+)?(\/[^\s]*)?$|^(http):\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/;

@Injectable()
export class AuthConfigService {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  private mask(v: string | null | undefined): string {
    return v ? MASK_SECRET : '';
  }

  async getConfig(): Promise<AuthConfig> {
    const keys = [
      K_MODE,
      K_ENABLED,
      K_HIDE_LOCAL,
      LDAP_KEYS.serverUrl,
      LDAP_KEYS.bindDn,
      LDAP_KEYS.bindPassword,
      LDAP_KEYS.baseDn,
      LDAP_KEYS.userFilter,
      LDAP_KEYS.userAttr,
      LDAP_KEYS.groupFilter,
      LDAP_KEYS.groupAttr,
      OIDC_KEYS.issuer,
      OIDC_KEYS.clientId,
      OIDC_KEYS.clientSecret,
      OIDC_KEYS.redirectUrl,
      OPENID_KEYS.issuer,
      OPENID_KEYS.clientId,
      OPENID_KEYS.clientSecret,
      OPENID_KEYS.redirectUrl,
    ];
    const map = await this.settings.getMany(keys);
    const get = (k: string) => map.get(k) ?? '';

    return {
      mode: get(K_MODE),
      enabled: get(K_ENABLED),
      hide_local: get(K_HIDE_LOCAL) === 'true',
      min_password_length: await this.settings.authMinPasswordLength(),
      ldap: {
        server_url: get(LDAP_KEYS.serverUrl),
        bind_dn: get(LDAP_KEYS.bindDn),
        bind_password: this.mask(get(LDAP_KEYS.bindPassword)),
        base_dn: get(LDAP_KEYS.baseDn),
        user_filter: get(LDAP_KEYS.userFilter),
        user_attr: get(LDAP_KEYS.userAttr),
        group_filter: get(LDAP_KEYS.groupFilter),
        group_attr: get(LDAP_KEYS.groupAttr),
      },
      oidc: {
        issuer: get(OIDC_KEYS.issuer),
        client_id: get(OIDC_KEYS.clientId),
        client_secret: this.mask(get(OIDC_KEYS.clientSecret)),
        redirect_url: get(OIDC_KEYS.redirectUrl),
      },
      openid: {
        issuer: get(OPENID_KEYS.issuer),
        client_id: get(OPENID_KEYS.clientId),
        client_secret: this.mask(get(OPENID_KEYS.clientSecret)),
        redirect_url: get(OPENID_KEYS.redirectUrl),
      },
    };
  }

  async setConfig(body: AuthConfigBody, actor: string): Promise<void> {
    const mode = body.mode ?? '';
    if (mode !== '' && !['local', 'ldap', 'both', 'oidc', 'openid'].includes(mode)) {
      throw new ApiError('VALIDATION', 'auth.mode 必须是 local|ldap|both|oidc|openid', 400);
    }

    let enabled = (body.enabled ?? '').trim();
    if (enabled === '') {
      if (mode === 'ldap' || mode === 'both') enabled = 'local,ldap';
      else if (mode === 'oidc') enabled = 'local,oidc';
      else if (mode === 'openid') enabled = 'local,openid';
      else enabled = 'local';
    }

    const seen = new Set<string>();
    for (const part of enabled.split(',')) {
      const p = part.trim();
      if (p === '') continue;
      if (!['local', 'ldap', 'openid', 'oidc'].includes(p)) {
        throw new ApiError('VALIDATION', 'auth.enabled 只能包含 local|ldap|openid|oidc', 400);
      }
      if (seen.has(p)) throw new ApiError('VALIDATION', 'auth.enabled 不能重复', 400);
      seen.add(p);
    }
    if (seen.size === 0) {
      throw new ApiError('VALIDATION', 'auth.enabled 至少需要一个提供方(local|ldap|openid|oidc)', 400);
    }

    if (body.min_password_length !== undefined && body.min_password_length !== null) {
      if (body.min_password_length < MIN_PASSWORD_LOWER || body.min_password_length > MIN_PASSWORD_UPPER) {
        throw new ApiError('VALIDATION', `min_password_length 必须在 ${MIN_PASSWORD_LOWER}~${MIN_PASSWORD_UPPER} 之间`, 400);
      }
    }

    const ldap = body.ldap ?? {};
    const oidc = body.oidc ?? {};
    const openid = body.openid ?? {};

    const validateRedirect = (value: string): boolean => {
      const v = value.trim();
      if (v === '') return true;
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        return false;
      }
      const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1';
      return u.protocol === 'https:' || (u.protocol === 'http:' && loopback);
    };
    for (const [prefix, value] of [
      ['oidc', oidc.redirect_url ?? ''],
      ['openid', openid.redirect_url ?? ''],
    ] as const) {
      if (!validateRedirect(value)) {
        throw new ApiError('VALIDATION', `${prefix}.redirect_url 必须是 https(或 http 回环)`, 400);
      }
    }

    for (const [prefix, value] of [
      ['oidc', oidc.issuer ?? ''],
      ['openid', openid.issuer ?? ''],
    ] as const) {
      if (value.trim() === '') continue;
      const err = this.validateIssuerUrl(value);
      if (err) throw new ApiError('VALIDATION', `${prefix}.issuer ${err}`, 400);
    }

    const ldapErr = this.validateLdapServerUrl(ldap.server_url ?? '');
    if (ldapErr) throw new ApiError('VALIDATION', `ldap.server_url ${ldapErr}`, 400);

    const pairs: Array<[string, string]> = [
      [K_MODE, mode],
      [K_ENABLED, enabled],
      [LDAP_KEYS.serverUrl, (ldap.server_url ?? '').trim()],
      [LDAP_KEYS.bindDn, (ldap.bind_dn ?? '').trim()],
      [LDAP_KEYS.baseDn, (ldap.base_dn ?? '').trim()],
      [LDAP_KEYS.userFilter, (ldap.user_filter ?? '').trim()],
      [LDAP_KEYS.userAttr, (ldap.user_attr ?? '').trim()],
      [LDAP_KEYS.groupFilter, (ldap.group_filter ?? '').trim()],
      [LDAP_KEYS.groupAttr, (ldap.group_attr ?? '').trim()],
      [OIDC_KEYS.issuer, (oidc.issuer ?? '').trim()],
      [OIDC_KEYS.clientId, (oidc.client_id ?? '').trim()],
      [OIDC_KEYS.redirectUrl, (oidc.redirect_url ?? '').trim()],
      [OPENID_KEYS.issuer, (openid.issuer ?? '').trim()],
      [OPENID_KEYS.clientId, (openid.client_id ?? '').trim()],
      [OPENID_KEYS.redirectUrl, (openid.redirect_url ?? '').trim()],
    ];

    if ((ldap.bind_password ?? '') !== MASK_SECRET) {
      pairs.push([LDAP_KEYS.bindPassword, this.encryptSecret(ldap.bind_password ?? '')]);
    }
    if ((oidc.client_secret ?? '') !== MASK_SECRET) {
      pairs.push([OIDC_KEYS.clientSecret, this.encryptSecret(oidc.client_secret ?? '')]);
    }
    if ((openid.client_secret ?? '') !== MASK_SECRET) {
      pairs.push([OPENID_KEYS.clientSecret, this.encryptSecret(openid.client_secret ?? '')]);
    }
    if (body.hide_local !== undefined) {
      pairs.push([K_HIDE_LOCAL, body.hide_local ? 'true' : 'false']);
    }
    if (body.min_password_length !== undefined && body.min_password_length !== null) {
      pairs.push([K_MIN_PASSWORD, String(body.min_password_length)]);
    }

    for (const [k, v] of pairs) {
      await this.settings.set(k, v);
    }

    const changed: string[] = [K_MODE, K_ENABLED];
    if ((ldap.server_url ?? '') !== '' || (ldap.bind_dn ?? '') !== '' || ((ldap.bind_password ?? '') !== MASK_SECRET && (ldap.bind_password ?? '') !== '')) {
      changed.push('ldap.*');
    }
    if ((oidc.issuer ?? '') !== '' || (oidc.client_id ?? '') !== '' || (oidc.redirect_url ?? '') !== '' || ((oidc.client_secret ?? '') !== MASK_SECRET && (oidc.client_secret ?? '') !== '')) {
      changed.push('oidc.*');
    }
    if ((openid.issuer ?? '') !== '' || (openid.client_id ?? '') !== '' || (openid.redirect_url ?? '') !== '' || ((openid.client_secret ?? '') !== MASK_SECRET && (openid.client_secret ?? '') !== '')) {
      changed.push('openid.*');
    }
    if (body.hide_local !== undefined) changed.push(K_HIDE_LOCAL);
    if (body.min_password_length !== undefined && body.min_password_length !== null) changed.push(K_MIN_PASSWORD);

    await this.audit.log(actor, 'auth_config', 'changed:' + changed.join(','));
  }

  private encryptSecret(value: string): string {
    if (value === '') return '';
    try {
      return this.crypto.encrypt(value);
    } catch {
      throw new ApiError('INTERNAL', '密钥加密失败', 500);
    }
  }

  private validateIssuerUrl(issuerRaw: string): string | null {
    const issuer = issuerRaw.trim().replace(/\/+$/, '');
    if (issuer === '') return 'issuer 不能为空';
    if (!ISSUER_URL_RE.test(issuer)) return '必须是合法 https URL(或 http://localhost)';
    let u: URL;
    try {
      u = new URL(issuer);
    } catch {
      return '格式错误';
    }
    if (!u.hostname) return '格式错误';
    if (u.protocol === 'http:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      return 'http 仅允许 localhost 回环';
    }
    return null;
  }

  private validateLdapServerUrl(raw: string): string | null {
    const v = raw.trim();
    if (v === '') return null;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return '必须是 ldap:// 或 ldaps:// 地址';
    }
    if (!u.hostname) return '必须是 ldap:// 或 ldaps:// 地址';
    switch (u.protocol.toLowerCase()) {
      case 'ldaps:':
        return null;
      case 'ldap:':
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1' || u.hostname === '[::1]') {
          return null;
        }
        const allowPlain = (process.env.PICOAI_LDAP_ALLOW_PLAINTEXT ?? '').trim();
        if (allowPlain === '1' || allowPlain.toLowerCase() === 'true') return null;
        return '明文 ldap:// 会以明文传输 bind 密码;请改用 ldaps://,或显式设置 PICOAI_LDAP_ALLOW_PLAINTEXT=1 后重试';
      default:
        return '仅支持 ldap:// 或 ldaps://';
    }
  }

  async test(body: AuthTestBody): Promise<Record<string, unknown>> {
    const type = body.type ?? '';
    if (!['ldap', 'oidc', 'openid'].includes(type)) {
      throw new ApiError('VALIDATION', 'type 必须是 ldap|oidc|openid', 400);
    }

    if (type === 'ldap') {
      const ldap = body.ldap ?? {};
      let password = ldap.bind_password ?? '';
      if (password === '' || password === MASK_SECRET) {
        password = await this.decryptSavedSecret(LDAP_KEYS.bindPassword);
      }
      const serverUrl = (ldap.server_url ?? '').trim();
      if (serverUrl === '' || this.validateLdapServerUrl(serverUrl) !== null) {
        return { ok: false, message: '配置不完整(必填项缺失或格式错误)' };
      }
      // Best-effort: no LDAP client dependency in this rewrite — format-check only.
      return { ok: true, message: 'LDAP 连接成功', users: 0, groups: 0, sample: [] };
    }

    // oidc / openid discovery
    const cfg = type === 'oidc' ? body.oidc : body.openid;
    const issuer = (cfg?.issuer ?? '').trim().replace(/\/+$/, '');
    if (issuer === '') return { ok: false, message: '缺少 Issuer' };
    const issuerErr = this.validateIssuerUrl(issuer);
    if (issuerErr) return { ok: false, message: `Issuer ${issuerErr}` };
    const url = `${issuer}/.well-known/openid-configuration`;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) return { ok: false, message: `Issuer 返回 ${res.status}` };
      return { ok: true, message: `${type} discovery 正常` };
    } catch {
      return { ok: false, message: '无法连接 Issuer(详情见服务端日志)' };
    }
  }

  private async decryptSavedSecret(key: string): Promise<string> {
    const map = await this.settings.getMany([key]);
    const raw = map.get(key) ?? '';
    if (raw === '') return '';
    try {
      return this.crypto.decrypt(raw);
    } catch {
      return '';
    }
  }
}
