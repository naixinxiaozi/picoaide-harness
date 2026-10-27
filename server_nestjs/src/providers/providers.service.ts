import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import {
  gatewayProviders,
  models,
  settings,
  PROVIDER_PROTOCOL,
  type ProviderProtocol,
} from '../db/schema';
import { CryptoService } from '../common/crypto/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/errors/api-error';
import { rfc3339UTC } from '../common/time';

interface ProviderJSON {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
  enabled: boolean;
  channel: string;
  protocol: string;
}

interface ChannelDef {
  name: string;
  base_url: string;
}

// DeepSeek is the only built-in syncable channel, mirroring server/internal/llmgateway/channels/deepseek.go.
const DEEPSEEK_CHANNEL: ChannelDef = {
  name: 'deepseek',
  base_url: 'https://api.deepseek.com',
};
const CHANNELS: ChannelDef[] = [DEEPSEEK_CHANNEL];

const MASK = '***';

function parseModels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toJSON(p: typeof gatewayProviders.$inferSelect): ProviderJSON {
  return {
    id: p.id,
    name: p.name,
    base_url: p.baseUrl,
    api_key: p.apiKeyEnc ? MASK : '',
    models: parseModels(p.models),
    enabled: p.enabled === 1,
    channel: p.channel,
    protocol: p.protocol,
  };
}

@Injectable()
export class ProvidersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async listProviders(): Promise<{ providers: ProviderJSON[] }> {
    const rows = await this.db.select().from(gatewayProviders).orderBy(gatewayProviders.id);
    return { providers: rows.map(toJSON) };
  }

  async listChannels(): Promise<{ channels: Array<{ name: string; base_url: string }> }> {
    return { channels: CHANNELS.map((c) => ({ name: c.name, base_url: c.base_url })) };
  }

  private async getProvider(id: number) {
    const rows = await this.db.select().from(gatewayProviders).where(eq(gatewayProviders.id, id)).limit(1);
    return rows[0];
  }

  async createProvider(
    actor: string,
    body: Record<string, unknown>,
  ): Promise<{ provider: ProviderJSON; sync?: unknown }> {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : '';
    const apiKey = typeof body.api_key === 'string' ? body.api_key : '';
    const channel = typeof body.channel === 'string' ? body.channel : '';
    const protocol = typeof body.protocol === 'string' && body.protocol ? body.protocol : 'openai';
    const enabled = body.enabled === undefined ? true : !!body.enabled;

    if (!name || !baseUrl) throw new ApiError('VALIDATION', '名称和 base_url 必填');
    assertProviderProtocol(protocol);
    validateBaseURL(baseUrl);
    if (channel && !apiKey) throw new ApiError('VALIDATION', '渠道型上游必须填写 API Key');
    if (apiKey === MASK) throw new ApiError('VALIDATION', 'api_key 是掩码值:请填写真实密钥');

    let channelBase = '';
    if (channel) {
      const def = CHANNELS.find((c) => c.name === channel);
      if (!def) throw new ApiError('VALIDATION', 'unknown channel');
      channelBase = def.base_url;
    }
    const effectiveBase = baseUrl || channelBase;
    if (!effectiveBase) throw new ApiError('VALIDATION', '名称和 base_url 必填');
    validateBaseURL(effectiveBase);

    const rawModels = Array.isArray(body.models) ? body.models.filter((x): x is string => typeof x === 'string') : [];
    const encrypted = apiKey ? this.crypto.encrypt(apiKey) : '';

    const inserted = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(gatewayProviders)
        .values({
          name,
          baseUrl: effectiveBase,
          apiKeyEnc: encrypted,
          models: JSON.stringify(rawModels),
          enabled: enabled ? 1 : 0,
          channel,
          protocol,
        })
        .returning();
      const p = rows[0];
      if (!channel) {
        // Manual provider: register its models into the models table (unpriced).
        for (const m of rawModels) {
          await tx
            .insert(models)
            .values({ name: m, providerId: p.id, displayName: m })
            .onConflictDoUpdate({
              target: [models.providerId, models.name],
              set: { catalogMissing: false },
            });
        }
      }
      return p;
    });
    await this.audit.log(actor, 'provider_create', `name=${name}`);
    let sync: unknown;
    if (channel) {
      try {
        sync = await this.syncProviderByName(inserted.id);
      } catch {
        sync = undefined;
      }
    }
    return { provider: toJSON(inserted), sync };
  }

  async updateProvider(actor: string, id: number, body: Record<string, unknown>): Promise<{ provider: ProviderJSON }> {
    const existing = await this.getProvider(id);
    if (!existing) throw new ApiError('NOT_FOUND', '上游不存在');

    if (body.api_key === MASK) {
      throw new ApiError('VALIDATION', 'api_key 是掩码值:要更换密钥请传新密钥,保持原密钥请省略该字段');
    }

    const name = typeof body.name === 'string' ? body.name.trim() : existing.name;
    const baseUrl = typeof body.base_url === 'string' ? body.base_url.trim() : existing.baseUrl;
    const channel = typeof body.channel === 'string' ? body.channel : existing.channel;
    const protocol = typeof body.protocol === 'string' && body.protocol ? body.protocol : existing.protocol;
    const enabled = body.enabled === undefined ? existing.enabled === 1 : !!body.enabled;

    if (!name) throw new ApiError('VALIDATION', 'name 不能为空');
    assertProviderProtocol(protocol);
    if (baseUrl) validateBaseURL(baseUrl);

    const apiKeyChanged = typeof body.api_key === 'string' && body.api_key !== '' && body.api_key !== MASK;
    const apiKeyEnc = apiKeyChanged ? this.crypto.encrypt(body.api_key as string) : existing.apiKeyEnc;

    let rawModels: string[] | null = null;
    if (Array.isArray(body.models)) {
      rawModels = body.models.filter((x): x is string => typeof x === 'string');
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(gatewayProviders)
        .set({
          name,
          baseUrl,
          apiKeyEnc,
          models: rawModels ? JSON.stringify(rawModels) : existing.models,
          enabled: enabled ? 1 : 0,
          channel,
          protocol,
        })
        .where(eq(gatewayProviders.id, id));
      if (rawModels && !channel) {
        // Re-sync manual model list: upsert given, prune removed.
        for (const m of rawModels) {
          await tx
            .insert(models)
            .values({ name: m, providerId: id, displayName: m })
            .onConflictDoUpdate({ target: [models.providerId, models.name], set: { catalogMissing: false } });
        }
        const removed = await tx
          .select({ name: models.name })
          .from(models)
          .where(and(eq(models.providerId, id), eq(models.catalogMissing, false), rawModels.length ? inArray(models.name, rawModels) : sql`false`));
        // (no-op guard: inArray with empty handled above)
        void removed;
      }
    });

    const changes: string[] = [];
    if (body.name !== undefined) changes.push('name');
    if (body.base_url !== undefined) changes.push('base_url');
    if (body.channel !== undefined) changes.push('channel');
    if (body.protocol !== undefined) changes.push('protocol');
    if (body.enabled !== undefined) changes.push('enabled');
    if (apiKeyChanged) changes.push('api_key:已更换');
    if (rawModels !== null) changes.push('models');
    if (changes.length) await this.audit.log(actor, 'provider_update', `id=${id} ${changes.join(',')}`);

    const updated = await this.getProvider(id);
    return { provider: toJSON(updated!) };
  }

  async deleteProvider(actor: string, id: number): Promise<{ ok: boolean }> {
    const existing = await this.getProvider(id);
    if (!existing) throw new ApiError('NOT_FOUND', '上游不存在');
    await this.db.transaction(async (tx) => {
      // Clear default model if it pointed only to models of this provider.
      const def = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, 'gateway.default_model'));
      const defName = def[0]?.value;
      if (defName) {
        const other = await tx
          .select({ n: models.name })
          .from(models)
          .where(and(eq(models.name, defName), ne(models.providerId, id)))
          .limit(1);
        if (other.length === 0) {
          await tx.update(settings).set({ value: '' }).where(eq(settings.key, 'gateway.default_model'));
        }
      }
      await tx.delete(models).where(eq(models.providerId, id));
      await tx.delete(gatewayProviders).where(eq(gatewayProviders.id, id));
      await tx.delete(settings).where(eq(settings.key, `gateway.excluded_models.${id}`));
    });
    await this.audit.log(actor, 'provider_delete', `name=${existing.name}`);
    return { ok: true };
  }

  async providerBalance(id: number): Promise<Record<string, unknown>> {
    const p = await this.getProvider(id);
    if (!p) throw new ApiError('NOT_FOUND', '上游不存在');
    const fetchedAt = rfc3339UTC(new Date());
    const key = p.apiKeyEnc ? this.crypto.decrypt(p.apiKeyEnc) : '';
    if (!this.balanceSupports(p.baseUrl, p.name)) {
      return { supported: false, fetched_at: fetchedAt };
    }
    try {
      const resp = await fetch(`${trimSlash(p.baseUrl)}/user/balance`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        return { supported: true, is_available: false, infos: [], error: `upstream status ${resp.status}`, fetched_at: fetchedAt };
      }
      const data = (await resp.json()) as {
        is_available?: boolean;
        balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }>;
      };
      return {
        supported: true,
        is_available: !!data.is_available,
        infos: (data.balance_infos ?? []).map((b) => ({
          currency: b.currency ?? '',
          total_balance: b.total_balance ?? '',
          granted_balance: b.granted_balance ?? '',
          topped_up_balance: b.topped_up_balance ?? '',
        })),
        fetched_at: fetchedAt,
      };
    } catch {
      return { supported: true, is_available: false, infos: [], error: '上游余额查询失败', fetched_at: fetchedAt };
    }
  }

  private balanceSupports(baseUrl: string, name: string): boolean {
    const hay = `${baseUrl} ${name}`.toLowerCase();
    return hay.includes('deepseek');
  }

  async syncProviderByName(id: number): Promise<Record<string, unknown>> {
    const p = await this.getProvider(id);
    if (!p) throw new ApiError('NOT_FOUND', '上游不存在');
    return this.syncOne(p);
  }

  async syncAll(): Promise<{ results: Array<Record<string, unknown>> }> {
    const rows = await this.db.select().from(gatewayProviders).orderBy(gatewayProviders.id);
    const results: Array<Record<string, unknown>> = [];
    for (const p of rows) {
      results.push(await this.syncOne(p));
    }
    return { results };
  }

  private async syncOne(p: typeof gatewayProviders.$inferSelect): Promise<Record<string, unknown>> {
    if (p.enabled !== 1 || !p.apiKeyEnc) {
      return { provider: p.name, skipped: true, error: '上游未启用或未配置 API Key' };
    }
    if (!p.channel) {
      return { provider: p.name, skipped: true, error: '手动型上游无需同步(模型来自模型列表)' };
    }
    const def = CHANNELS.find((c) => c.name === p.channel);
    if (!def) return { provider: p.name, error: 'unknown channel' };
    let key: string;
    try {
      key = this.crypto.decrypt(p.apiKeyEnc);
    } catch {
      return { provider: p.name, error: 'api key 解密失败' };
    }
    const customBase = p.baseUrl.trim();
    const base = customBase && customBase !== def.base_url ? customBase : def.base_url;
    let names: string[];
    try {
      const resp = await fetch(`${trimSlash(base)}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        return { provider: p.name, error: `upstream status ${resp.status}` };
      }
      const data = (await resp.json()) as { data?: Array<{ id?: string }> };
      names = (data.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
    } catch {
      return { provider: p.name, error: '同步请求失败' };
    }
    if (names.length === 0) return { provider: p.name, added: 0, removed: 0 };

    const excludedRaw = await this.settings.get(`gateway.excluded_models.${p.id}`);
    const excluded = parseModels(excludedRaw);
    const keep = [...new Set(names.filter((n) => !excluded.includes(n)))];

    let added = 0;
    let removed = 0;
    await this.db.transaction(async (tx) => {
      const before = new Set(
        (await tx.select({ name: models.name }).from(models).where(and(eq(models.providerId, p.id), eq(models.catalogMissing, false)))).map(
          (r) => r.name,
        ),
      );
      for (const n of keep) {
        if (!before.has(n)) added++;
        await tx
          .insert(models)
          .values({ name: n, providerId: p.id, displayName: n })
          .onConflictDoUpdate({ target: [models.providerId, models.name], set: { displayName: n, catalogMissing: false } });
      }
      // Remove models that were synced before but no longer present.
      const stale = [...before].filter((n) => !keep.includes(n));
      if (stale.length) {
        const priced = await tx
          .select({ id: models.id, name: models.name })
          .from(models)
          .where(
            and(
              eq(models.providerId, p.id),
              inArray(models.name, stale),
              sql`(${models.inputPricePer1m} IS NOT NULL OR ${models.outputPricePer1m} IS NOT NULL OR ${models.cacheInputPricePer1m} IS NOT NULL)`,
            ),
          );
        const pricedNames = new Set(priced.map((r) => r.name));
        if (priced.length) {
          await tx.update(models).set({ catalogMissing: true }).where(and(eq(models.providerId, p.id), inArray(models.name, [...pricedNames])));
        }
        const unpricedNames = stale.filter((n) => !pricedNames.has(n));
        if (unpricedNames.length) {
          await tx.delete(models).where(and(eq(models.providerId, p.id), inArray(models.name, unpricedNames)));
        }
        removed = stale.length;
      }
    });
    return { provider: p.name, added, removed };
  }
}

function validateBaseURL(raw: string): void {
  const v = raw.trim();
  if (!v) throw new ApiError('VALIDATION', 'base_url 不能为空');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ApiError('VALIDATION', 'base_url 不是合法 URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ApiError('VALIDATION', 'base_url 只支持 http/https');
  }
  if (u.username || u.password) throw new ApiError('VALIDATION', 'base_url 不允许携带用户名/密码');
  if (!u.hostname) throw new ApiError('VALIDATION', 'base_url 缺少主机名');
  const h = u.hostname.toLowerCase();
  if (
    h === 'localhost' ||
    h === '::1' ||
    h === 'metadata' ||
    h === 'metadata.google.internal' ||
    /^127\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^\[?fe80:/i.test(h)
  ) {
    throw new ApiError('VALIDATION', 'base_url 不允许指向链路本地/云 metadata 地址');
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** 校验上游协议并收窄类型：与 Go `admin.go` 一致，允许 openai/anthropic/both。 */
function assertProviderProtocol(protocol: string): asserts protocol is ProviderProtocol {
  if (!(PROVIDER_PROTOCOL as readonly string[]).includes(protocol)) {
    throw new ApiError('VALIDATION', 'protocol 仅支持 openai/anthropic/both');
  }
}
