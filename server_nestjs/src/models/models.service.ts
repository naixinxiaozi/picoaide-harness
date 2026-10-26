import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../db/database.module';
import { gatewayProviders, models, settings, usage } from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/errors/api-error';

interface ModelJSON {
  id: number;
  name: string;
  provider_id: number;
  display_name: string;
  default_params: string;
  input_modalities: string[];
  input_price_per_1m: number | null;
  output_price_per_1m: number | null;
  cache_input_price_per_1m: number | null;
  offpeak_discount: number | null;
  catalog_missing: boolean;
  provider_name: string;
  provider_channel: string;
  provider_enabled: boolean;
}

interface ModelRow {
  id: number;
  name: string;
  providerId: number;
  displayName: string | null;
  defaultParams: string;
  inputModalities: string;
  inputPricePer1m: number | null;
  outputPricePer1m: number | null;
  cacheInputPricePer1m: number | null;
  offpeakDiscount: number | null;
  catalogMissing: boolean;
  providerName: string;
  providerChannel: string;
  providerEnabled: number;
}

function parseStringArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toJSON(m: ModelRow): ModelJSON {
  return {
    id: m.id,
    name: m.name,
    provider_id: m.providerId,
    display_name: m.displayName ?? m.name,
    default_params: m.defaultParams || '',
    input_modalities: parseStringArray(m.inputModalities),
    input_price_per_1m: m.inputPricePer1m,
    output_price_per_1m: m.outputPricePer1m,
    cache_input_price_per_1m: m.cacheInputPricePer1m,
    offpeak_discount: m.offpeakDiscount,
    catalog_missing: m.catalogMissing,
    provider_name: m.providerName,
    provider_channel: m.providerChannel,
    provider_enabled: m.providerEnabled === 1,
  };
}

/** Optional float: undefined=未传(保持), null=清空, number=设置。 */
function optionalFloat(v: unknown, field: string): { set: boolean; value: number | null } | undefined {
  if (v === undefined) return undefined;
  if (v === null) return { set: true, value: null };
  if (typeof v === 'number' && Number.isFinite(v)) return { set: true, value: v };
  throw new ApiError('VALIDATION', `${field} 必须是数值`);
}

@Injectable()
export class ModelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  async listModels(): Promise<{ models: ModelJSON[] }> {
    const rows = await this.db
      .select({
        id: models.id,
        name: models.name,
        providerId: models.providerId,
        displayName: models.displayName,
        defaultParams: models.defaultParams,
        inputModalities: models.inputModalities,
        inputPricePer1m: models.inputPricePer1m,
        outputPricePer1m: models.outputPricePer1m,
        cacheInputPricePer1m: models.cacheInputPricePer1m,
        offpeakDiscount: models.offpeakDiscount,
        catalogMissing: models.catalogMissing,
        providerName: gatewayProviders.name,
        providerChannel: gatewayProviders.channel,
        providerEnabled: gatewayProviders.enabled,
      })
      .from(models)
      .innerJoin(gatewayProviders, eq(models.providerId, gatewayProviders.id))
      .orderBy(models.id);
    return { models: rows.map(toJSON) };
  }

  private async getModel(id: number): Promise<ModelRow | undefined> {
    const rows = await this.db
      .select({
        id: models.id,
        name: models.name,
        providerId: models.providerId,
        displayName: models.displayName,
        defaultParams: models.defaultParams,
        inputModalities: models.inputModalities,
        inputPricePer1m: models.inputPricePer1m,
        outputPricePer1m: models.outputPricePer1m,
        cacheInputPricePer1m: models.cacheInputPricePer1m,
        offpeakDiscount: models.offpeakDiscount,
        catalogMissing: models.catalogMissing,
        providerName: gatewayProviders.name,
        providerChannel: gatewayProviders.channel,
        providerEnabled: gatewayProviders.enabled,
      })
      .from(models)
      .innerJoin(gatewayProviders, eq(models.providerId, gatewayProviders.id))
      .where(eq(models.id, id))
      .limit(1);
    return rows[0];
  }

  async createModel(actor: string, body: Record<string, unknown>): Promise<{ model: ModelJSON }> {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const providerId = typeof body.provider_id === 'number' ? body.provider_id : 0;
    if (!name || !providerId) throw new ApiError('VALIDATION', '模型名和 provider 必填');

    const provider = await this.db
      .select({ id: gatewayProviders.id, channel: gatewayProviders.channel })
      .from(gatewayProviders)
      .where(eq(gatewayProviders.id, providerId))
      .limit(1);
    if (provider.length === 0) throw new ApiError('VALIDATION', '所属上游不存在');

    const input = optionalFloat(body.input_price_per_1m, 'input_price_per_1m');
    const output = optionalFloat(body.output_price_per_1m, 'output_price_per_1m');
    const cache = optionalFloat(body.cache_input_price_per_1m, 'cache_input_price_per_1m');
    const offpeak = optionalFloat(body.offpeak_discount, 'offpeak_discount');
    validatePrices(input?.value ?? 0, output?.value ?? 0, cache?.value ?? 0, offpeak?.value ?? undefined);
    const modalities = validateInputModalities(body.input_modalities);

    const displayName = typeof body.display_name === 'string' ? body.display_name : '';
    const defaultParams = typeof body.default_params === 'string' ? body.default_params : '';

    const existing = await this.db
      .select({ id: models.id })
      .from(models)
      .where(and(eq(models.name, name), eq(models.providerId, providerId)))
      .limit(1);
    if (existing.length > 0) throw new ApiError('VALIDATION', '模型名已存在');

    const inserted = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(models)
        .values({
          name,
          providerId,
          displayName: displayName || null,
          defaultParams,
          inputPricePer1m: input?.value ?? null,
          outputPricePer1m: output?.value ?? null,
          cacheInputPricePer1m: cache?.value ?? null,
          offpeakDiscount: offpeak?.value ?? null,
          inputModalities: JSON.stringify(modalities),
          catalogMissing: false,
        })
        .returning({ id: models.id });
      // Un-exclude the newly created model name (channel re-sync resurrection guard).
      const excluded = await this.excludedOf(providerId);
      const next = removeName(excluded, name);
      await tx
        .insert(settings)
        .values({ key: `gateway.excluded_models.${providerId}`, value: JSON.stringify(next) })
        .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(next) } });
      return rows[0].id;
    });

    await this.audit.log(actor, 'model_create', `name=${name}`);
    const m = await this.getModel(inserted);
    return { model: toJSON(m!) };
  }

  async updateModel(actor: string, id: number, body: Record<string, unknown>): Promise<{ model: ModelJSON }> {
    const m = await this.getModel(id);
    if (!m) throw new ApiError('NOT_FOUND', '模型不存在');

    const input = optionalFloat(body.input_price_per_1m, 'input_price_per_1m');
    const output = optionalFloat(body.output_price_per_1m, 'output_price_per_1m');
    const cache = optionalFloat(body.cache_input_price_per_1m, 'cache_input_price_per_1m');
    const offpeak = optionalFloat(body.offpeak_discount, 'offpeak_discount');

    const nextName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : m.name;
    if (nextName !== m.name) {
      const hasUsage = await this.db.select({ id: usage.id }).from(usage).where(eq(usage.model, m.name)).limit(1);
      if (hasUsage.length > 0) throw new ApiError('VALIDATION', '该模型已有用量记录,不允许改名');
      if (m.providerChannel) throw new ApiError('VALIDATION', '渠道同步模型由上游命名,不允许改名');
    }
    const nextProviderId = typeof body.provider_id === 'number' && body.provider_id ? body.provider_id : m.providerId;
    if (typeof body.provider_id === 'number' && body.provider_id !== m.providerId) {
      const provider = await this.db.select({ id: gatewayProviders.id }).from(gatewayProviders).where(eq(gatewayProviders.id, nextProviderId)).limit(1);
      if (provider.length === 0) throw new ApiError('VALIDATION', '所属上游不存在');
    }

    validatePrices(input?.value ?? m.inputPricePer1m ?? 0, output?.value ?? m.outputPricePer1m ?? 0, cache?.value ?? m.cacheInputPricePer1m ?? 0, offpeak?.value ?? m.offpeakDiscount ?? undefined);
    const modalities = body.input_modalities !== undefined ? validateInputModalities(body.input_modalities) : undefined;

    await this.db.transaction(async (tx) => {
      await tx
        .update(models)
        .set({
          name: nextName,
          providerId: nextProviderId,
          displayName: typeof body.display_name === 'string' ? (body.display_name || null) : m.displayName,
          defaultParams: typeof body.default_params === 'string' ? body.default_params : m.defaultParams,
          inputPricePer1m: input ? input.value : m.inputPricePer1m,
          outputPricePer1m: output ? output.value : m.outputPricePer1m,
          cacheInputPricePer1m: cache ? cache.value : m.cacheInputPricePer1m,
          offpeakDiscount: offpeak ? offpeak.value : m.offpeakDiscount,
          inputModalities: modalities ? JSON.stringify(modalities) : m.inputModalities,
        })
        .where(eq(models.id, id));
    });

    await this.audit.log(actor, 'model_update', `id=${id} name=${m.name}`);
    const updated = await this.getModel(id);
    return { model: toJSON(updated!) };
  }

  async deleteModel(actor: string, id: number): Promise<{ ok: boolean }> {
    const m = await this.getModel(id);
    if (!m) throw new ApiError('NOT_FOUND', '模型不存在');
    await this.db.transaction(async (tx) => {
      await tx.delete(models).where(eq(models.id, id));
      if (m.providerChannel) {
        const excluded = await this.excludedOf(m.providerId);
        const next = [...new Set([...excluded, m.name])];
        await tx
          .insert(settings)
          .values({ key: `gateway.excluded_models.${m.providerId}`, value: JSON.stringify(next) })
          .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(next) } });
      }
    });
    await this.audit.log(actor, 'model_delete', `id=${id} name=${m.name}`);
    return { ok: true };
  }

  private async excludedOf(providerId: number): Promise<string[]> {
    const rows = await this.db.select({ value: settings.value }).from(settings).where(eq(settings.key, `gateway.excluded_models.${providerId}`));
    return parseStringArray(rows[0]?.value ?? '[]');
  }
}

function validatePrices(input: number, output: number, cache: number, offpeak: number | undefined): void {
  if (input < 0) throw new ApiError('VALIDATION', 'input_price_per_1m 不能为负数');
  if (output < 0) throw new ApiError('VALIDATION', 'output_price_per_1m 不能为负数');
  if (cache < 0) throw new ApiError('VALIDATION', 'cache_input_price_per_1m 不能为负数');
  if (offpeak !== undefined && (offpeak <= 0 || offpeak > 1)) {
    throw new ApiError('VALIDATION', 'offpeak_discount 必须在 (0,1] 之间(1 = 无峰谷价)');
  }
}

function validateInputModalities(v: unknown): string[] {
  if (v === undefined || v === null) return ['text'];
  if (!Array.isArray(v)) throw new ApiError('VALIDATION', 'input_modalities 必须是数组');
  const items = v.filter((x): x is string => typeof x === 'string');
  if (items.length === 0) throw new ApiError('VALIDATION', 'input_modalities 不能为空数组');
  const seen = new Set<string>();
  for (const m of items) {
    if (m !== 'text' && m !== 'image') throw new ApiError('VALIDATION', 'input_modalities 只能包含 text/image');
    if (seen.has(m)) throw new ApiError('VALIDATION', 'input_modalities 不能包含重复项');
    seen.add(m);
  }
  return items;
}

function removeName(list: string[], name: string): string[] {
  return list.filter((x) => x !== name);
}
