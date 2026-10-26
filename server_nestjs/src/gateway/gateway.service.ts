import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  type ExtractTablesWithRelations,
} from 'drizzle-orm';
import type { PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type { Response as ExpressResponse } from 'express';
import { DRIZZLE, type Database } from '../db/database.module';
import {
  balanceLedger,
  clientErrorReportingStatus,
  gatewayProviders,
  modelConcurrencyStats,
  models,
  usage,
  users,
  schema,
  type UsageKind,
  type User,
  type LedgerKind,
} from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { CryptoService } from '../common/crypto/crypto.service';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/errors/api-error';
import { quantizeMoney, roundMicro } from '../common/money';
import { rfc3339UTC, beijingDayStr } from '../common/time';
import {
  costOfAt,
  estimateCompletionTokens,
  estimateEmbeddingPromptTokens,
  estimatePromptTokensFromBytes,
  moneyToMicro,
  microToMoney,
  parsePeakWindows,
  searchFee,
  type PeakWindow,
} from './pricing';
import { gatewayStats } from './gateway-stats';

type Tx = PgTransaction<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

interface Upstream {
  id: number;
  name: string;
  baseUrl: string;
  apiKey: string;
  channel: string;
  protocol: 'openai' | 'anthropic';
}

interface Refusal {
  code: 'BALANCE_EXHAUSTED' | 'MODEL_NOT_PRICED' | 'MODEL_ROUTING_UNAVAILABLE';
  message: string;
  reason: string;
  requiredMicro?: number;
}

interface PriceInputs {
  input: number;
  output: number;
  cache: number;
  offpeak: number | null;
  windows: PeakWindow[];
  searchPer1K: number;
}

type Identity = 'openai' | 'responses' | 'anthropic' | 'none';
type Endpoint = '/chat/completions' | '/completions' | '/responses' | '/messages' | '/embeddings';

const MAX_UPSTREAM_BODY = 32 * 1024 * 1024;
const MAX_INFLIGHT_PER_USER = 32;
const DEFAULT_RATE_LIMIT = 0;
const BALANCE_FLOOR_EPSILON = 1e-9;
const UNPRICED_POLICY_KEY = 'gateway.unpriced_model_policy';
const PEAK_WINDOWS_KEY = 'usage.peak_windows';
const SEARCH_PRICE_KEY = 'usage.search_price_per_1k';
const RATE_LIMIT_KEY = 'gateway.rate_limit';
const BALANCE_ENABLED_KEY = 'balance.enabled';

const PASS_HEADERS = [
  'content-type',
  'retry-after',
  'x-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
] as const;

/** 上游 URL：base 去尾 /，若不以 /v1 结尾则补 /v1，再拼 path。 */
function upstreamURL(base: string, path: string): string {
  let b = base.replace(/\/+$/, '');
  if (!b.endsWith('/v1')) b += '/v1';
  return b + path;
}

function satAdd(a: number, b: number): number {
  const s = a + b;
  return s > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : s;
}

function usageValue(primary: unknown, fallback: unknown): number {
  const p = typeof primary === 'number' && primary > 0 ? primary : 0;
  const f = typeof fallback === 'number' && fallback > 0 ? fallback : 0;
  return p > 0 ? p : f;
}

function stripDataPrefix(raw: string): string {
  let t = raw.trim();
  if (t.startsWith('data:')) t = t.slice(5).trimStart();
  return t;
}

function parseOpenAIUsage(raw: string): {
  pt: number;
  ct: number;
  cache: number;
  ok: boolean;
} {
  const text = stripDataPrefix(raw);
  if (text === '[DONE]' || text === '') return { pt: 0, ct: 0, cache: 0, ok: false };
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { pt: 0, ct: 0, cache: 0, ok: false };
  }
  const u = (obj as Record<string, unknown>)?.usage ?? (obj as Record<string, unknown>);
  const rec = u as Record<string, unknown>;
  const pt = usageValue(rec.prompt_tokens, rec.input_tokens);
  const ct = usageValue(rec.completion_tokens, rec.output_tokens);
  const hit = usageValue(rec.prompt_cache_hit_tokens, undefined);
  const miss = usageValue(rec.prompt_cache_miss_tokens, undefined);
  const details = (rec.prompt_tokens_details ?? rec.input_tokens_details) as
    | Record<string, unknown>
    | undefined;
  let cache = 0;
  if (hit > 0) cache = hit;
  else if (miss > 0) cache = Math.max(pt - miss, 0);
  else {
    const cached = usageValue(details?.cached_tokens, undefined);
    if (cached > 0) cache = cached;
  }
  return { pt: Math.max(pt, 0), ct: Math.max(ct, 0), cache: Math.max(cache, 0), ok: pt > 0 || ct > 0 };
}

function parseAnthropicUsage(raw: string): {
  pt: number;
  ct: number;
  cache: number;
  ok: boolean;
} {
  const text = stripDataPrefix(raw);
  if (text === '[DONE]' || text === '' || text.startsWith('event:')) {
    return { pt: 0, ct: 0, cache: 0, ok: false };
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { pt: 0, ct: 0, cache: 0, ok: false };
  }
  const rec = obj as Record<string, unknown>;
  const u = (rec.usage ?? (rec.message as Record<string, unknown> | undefined)?.usage) as
    | Record<string, unknown>
    | undefined;
  if (!u) return { pt: 0, ct: 0, cache: 0, ok: false };
  const input = usageValue(u.input_tokens, undefined);
  const output = usageValue(u.output_tokens, undefined);
  const cacheRead = usageValue(u.cache_read_input_tokens, undefined);
  const cacheCreate = usageValue(u.cache_creation_input_tokens, undefined);
  const pt = satAdd(satAdd(input, cacheRead), cacheCreate);
  return { pt, ct: Math.max(output, 0), cache: Math.max(cacheRead, 0), ok: pt > 0 || output > 0 };
}

/** 统计 web_search 成功返回次数（usage.server_tool_use 与 content 块取 max）。 */
function countWebSearches(obj: unknown): number {
  const rec = (obj ?? {}) as Record<string, unknown>;
  const u = (rec.usage ?? {}) as Record<string, unknown>;
  const reported = usageValue(
    (u.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests,
    undefined,
  );
  let blocks = 0;
  const content = rec.content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'web_search_tool_result') continue;
      const items = block.content;
      if (
        Array.isArray(items) &&
        items.some((i) => (i as Record<string, unknown>)?.type === 'web_search_result')
      ) {
        blocks += 1;
      }
    }
  }
  return Math.max(reported, blocks, 0);
}

/** 移除顶层 dsh_ 扩展字段（上游扩展前缀）。 */
function stripUpstreamExtensions(obj: Record<string, unknown>): Record<string, unknown> {
  let removed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('dsh_')) {
      removed = true;
      continue;
    }
    out[k] = v;
  }
  return removed ? out : obj;
}

function parseJsonObject(raw: Buffer | Uint8Array | string): Record<string, unknown> {
  const text =
    typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new ApiError('VALIDATION', '请求体不是合法 JSON');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ApiError('VALIDATION', '请求体必须是 JSON 对象');
  }
  return obj as Record<string, unknown>;
}

function parseIntSetting(v: string | null | undefined, fallback: number): number {
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function parseFloatSetting(v: string | null | undefined, fallback: number): number {
  if (v == null || v === '') return fallback;
  const n = parseFloat(v);
  return Number.isNaN(n) ? fallback : n;
}

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);
  private readonly concurrencyMeter = new Map<string, number>();
  private readonly inflight = new Map<number, number>();
  private readonly balanceAdmissionFloor = new Map<number, number>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // 并发计量
  // ---------------------------------------------------------------------------
  beginConcurrency(model: string): () => void {
    let done = false;
    this.concurrencyMeter.set(model, (this.concurrencyMeter.get(model) ?? 0) + 1);
    this.recordConcurrencySample(model, this.concurrencyMeter.get(model) ?? 1).catch(() => undefined);
    return () => {
      if (done) return;
      done = true;
      const cur = this.concurrencyMeter.get(model) ?? 0;
      if (cur <= 1) this.concurrencyMeter.delete(model);
      else this.concurrencyMeter.set(model, cur - 1);
    };
  }

  snapshotConcurrency(): Map<string, number> {
    return new Map(this.concurrencyMeter);
  }

  private async recordConcurrencySample(model: string, current: number): Promise<void> {
    const at = new Date();
    const day = at.toISOString().slice(0, 10);
    await this.db
      .insert(modelConcurrencyStats)
      .values({ model, day, maxConcurrency: current, peakAt: at })
      .onConflictDoUpdate({
        target: [modelConcurrencyStats.model, modelConcurrencyStats.day],
        set: {
          maxConcurrency: sql`GREATEST(${modelConcurrencyStats.maxConcurrency}, ${current})`,
          peakAt: sql`CASE WHEN ${current} > ${modelConcurrencyStats.maxConcurrency} THEN ${at} ELSE ${modelConcurrencyStats.peakAt} END`,
        },
      });
  }

  async peakConcurrencyByModel(since: Date): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        model: modelConcurrencyStats.model,
        max: sql<number>`max(${modelConcurrencyStats.maxConcurrency})::int`,
      })
      .from(modelConcurrencyStats)
      .where(sql`${modelConcurrencyStats.day} >= ${since.toISOString().slice(0, 10)}`)
      .groupBy(modelConcurrencyStats.model);
    return new Map(rows.map((r) => [r.model, r.max]));
  }

  // ---------------------------------------------------------------------------
  // 在飞限制（并发护栏）
  // ---------------------------------------------------------------------------
  private async acquireInflight(userId: number): Promise<void> {
    const cur = this.inflight.get(userId) ?? 0;
    if (cur >= MAX_INFLIGHT_PER_USER) {
      throw new ApiError('RATE_LIMITED', '并发请求过多,请稍后再试');
    }
    this.inflight.set(userId, cur + 1);
  }

  private releaseInflight(userId: number): void {
    const cur = this.inflight.get(userId) ?? 0;
    if (cur <= 1) this.inflight.delete(userId);
    else this.inflight.set(userId, cur - 1);
  }

  private async rateLimitAllow(userId: number): Promise<void> {
    const limit = parseIntSetting(await this.settings.get(RATE_LIMIT_KEY), DEFAULT_RATE_LIMIT);
    if (limit <= 0) return;
    // 简化为进程内固定窗口（每分钟）；跨实例精确限流需接入外部存储。
    const nowMinute = Math.floor(Date.now() / 60_000);
    const key = `${userId}:${nowMinute}`;
    const cur = this.rateWindow.get(key) ?? 0;
    if (cur >= limit) throw new ApiError('RATE_LIMITED', '请求过于频繁,请稍后再试');
    this.rateWindow.set(key, cur + 1);
  }

  private readonly rateWindow = new Map<string, number>();

  // ---------------------------------------------------------------------------
  // 上游/模型解析
  // ---------------------------------------------------------------------------
  private async loadUser(userId: number): Promise<User> {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!u) throw new ApiError('AUTH_FAILED', '账号不存在或已禁用', 401);
    return u;
  }

  private async matchModelsByProtocol(
    modelName: string,
    protocol: 'openai' | 'anthropic',
  ): Promise<Upstream[]> {
    const providers = await this.db
      .select()
      .from(gatewayProviders)
      .where(and(eq(gatewayProviders.enabled, 1), eq(gatewayProviders.protocol, protocol)))
      .orderBy(gatewayProviders.id);
    const synced = await this.db
      .select({ providerId: models.providerId })
      .from(models)
      .where(and(eq(models.name, modelName), eq(models.catalogMissing, false)));
    const syncedIds = new Set(synced.map((r) => r.providerId));
    const out: Upstream[] = [];
    for (const p of providers) {
      const list = safeParseStringArray(p.models);
      if (!syncedIds.has(p.id) && !list.includes(modelName)) continue;
      let apiKey = '';
      try {
        apiKey = this.crypto.decrypt(p.apiKeyEnc);
      } catch {
        continue;
      }
      out.push({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey,
        channel: p.channel,
        protocol: p.protocol,
      });
    }
    return out;
  }

  private async modelPricesForProvider(
    providerId: number,
    modelName: string,
  ): Promise<{ input: number; output: number; cache: number; offpeak: number | null }> {
    const [specific] = await this.db
      .select()
      .from(models)
      .where(and(eq(models.providerId, providerId), eq(models.name, modelName)))
      .limit(1);
    if (specific) {
      return {
        input: specific.inputPricePer1m ?? 0,
        output: specific.outputPricePer1m ?? 0,
        cache: specific.cacheInputPricePer1m ?? 0,
        offpeak: specific.offpeakDiscount,
      };
    }
    const [g] = await this.db
      .select()
      .from(models)
      .where(eq(models.name, modelName))
      .orderBy(models.providerId)
      .limit(1);
    return {
      input: g?.inputPricePer1m ?? 0,
      output: g?.outputPricePer1m ?? 0,
      cache: g?.cacheInputPricePer1m ?? 0,
      offpeak: g?.offpeakDiscount ?? null,
    };
  }

  private async modelPricesForProviders(
    ids: number[],
    modelName: string,
  ): Promise<Map<number, { input: number; output: number }>> {
    const map = new Map<number, { input: number; output: number }>();
    const rows = await this.db
      .select()
      .from(models)
      .where(and(inArray(models.providerId, ids), eq(models.name, modelName)));
    for (const r of rows) {
      map.set(r.providerId, { input: r.inputPricePer1m ?? 0, output: r.outputPricePer1m ?? 0 });
    }
    for (const id of ids) {
      if (!map.has(id)) {
        const [g] = await this.db
          .select()
          .from(models)
          .where(eq(models.name, modelName))
          .orderBy(models.providerId)
          .limit(1);
        map.set(id, { input: g?.inputPricePer1m ?? 0, output: g?.outputPricePer1m ?? 0 });
      }
    }
    return map;
  }

  private async modelDefaultParams(modelName: string): Promise<Record<string, unknown>> {
    const [row] = await this.db
      .select({ defaultParams: models.defaultParams })
      .from(models)
      .where(and(eq(models.name, modelName), eq(models.catalogMissing, false)))
      .orderBy(models.providerId)
      .limit(1);
    if (!row) return {};
    try {
      const v = JSON.parse(row.defaultParams);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async unpricedModelPolicy(): Promise<string> {
    return (await this.settings.get(UNPRICED_POLICY_KEY)) ?? 'reject';
  }

  private async loadPriceInputs(providerId: number, modelName: string): Promise<PriceInputs> {
    const prices = await this.modelPricesForProvider(providerId, modelName);
    const [peakRaw, searchRaw] = await Promise.all([
      this.settings.get(PEAK_WINDOWS_KEY),
      this.settings.get(SEARCH_PRICE_KEY),
    ]);
    return {
      ...prices,
      windows: parsePeakWindows(peakRaw),
      searchPer1K: parseFloatSetting(searchRaw, 0),
    };
  }

  // ---------------------------------------------------------------------------
  // 余额准入闸门
  // ---------------------------------------------------------------------------
  private billableMicroFor(
    promptTokens: number,
    inputPer1M: number,
    hasOutput: boolean,
    outputPer1M: number,
  ): { micro: number; ok: boolean } {
    if (promptTokens <= 0) return { micro: 0, ok: false };
    const inCost = inputPer1M > 0 ? (promptTokens / 1e6) * inputPer1M : 0;
    const outCost = hasOutput && outputPer1M > 0 ? (1 / 1e6) * outputPer1M : 0;
    if (inCost <= 0 && outCost <= 0) return { micro: 0, ok: false };
    const micro = moneyToMicro(inCost + outCost);
    if (micro <= 0) return { micro: 0, ok: false };
    return { micro, ok: true };
  }

  private async balanceAdmissionBlocked(
    user: User,
    modelName: string,
    promptTokens: number,
    where: string,
    protocol: 'openai' | 'anthropic',
  ): Promise<Refusal | null> {
    if (user.isAdmin === 1) return null;
    const enabledRaw = await this.settings.get(BALANCE_ENABLED_KEY);
    if (enabledRaw !== 'true' && enabledRaw !== '1') return null;
    if (user.balanceActivatedAt == null) return null;

    const balanceMicro = moneyToMicro(user.balanceMoney);
    if (quantizeMoney(user.balanceMoney) <= 0) {
      return {
        code: 'BALANCE_EXHAUSTED',
        message: '账户余额不足,请联系管理员充值',
        reason: 'non_positive',
      };
    }
    const floor = this.balanceAdmissionFloor.get(user.id);
    if (floor != null && balanceMicro <= floor) {
      return {
        code: 'BALANCE_EXHAUSTED',
        message: '账户余额不足以支付一次调用,请充值后重试',
        reason: 'learned_floor',
        requiredMicro: floor,
      };
    }

    const candidates = await this.matchModelsByProtocol(modelName, protocol);
    if (candidates.length === 0) return null; // 后续 404

    const hasOutput = where !== 'embeddings';
    const policy = await this.unpricedModelPolicy();
    const prices = await this.modelPricesForProviders(
      candidates.map((c) => c.id),
      modelName,
    );
    if (policy !== 'allow') {
      for (const c of candidates) {
        const pr = prices.get(c.id) ?? { input: 0, output: 0 };
        if (pr.input <= 0 && (!hasOutput || pr.output <= 0)) {
          return {
            code: 'MODEL_NOT_PRICED',
            message: '该模型未配置价格,暂不可用(请联系管理员在网关的模型列表里为它填写价格)',
            reason: 'unpriced_model',
          };
        }
        const m = this.billableMicroFor(promptTokens, pr.input, hasOutput, pr.output);
        if (!m.ok) {
          return {
            code: 'MODEL_NOT_PRICED',
            message:
              '该模型价格过低,单次调用计费不足最小单位,暂不可用(请联系管理员调整模型价格;若它确实是免费/内部模型,请在网关配置里把未定价模型策略设为 allow)',
            reason: 'unbilled_price',
          };
        }
      }
    }
    const first = prices.get(candidates[0].id) ?? { input: 0, output: 0 };
    const need = this.billableMicroFor(promptTokens, first.input, hasOutput, first.output);
    if (need.ok && balanceMicro < need.micro) {
      return {
        code: 'BALANCE_EXHAUSTED',
        message: '账户余额不足以支付本次请求,请充值后重试',
        reason: 'min_billable',
        requiredMicro: need.micro,
      };
    }
    return null;
  }

  private recordAdmissionRejection(
    user: User,
    endpoint: string,
    model: string,
    reason: string,
    requiredMicro: number,
  ): void {
    gatewayStats.admissionRejections += 1;
    gatewayStats.lastRejection = {
      userId: user.id,
      username: user.username,
      endpoint,
      model,
      reason,
      requiredMoney: microToMoney(requiredMicro),
      balanceMoney: quantizeMoney(user.balanceMoney),
      at: rfc3339UTC(new Date()),
    };
  }

  private raiseAdmissionFloor(userId: number, balanceMoney: number): void {
    const micro = moneyToMicro(balanceMoney);
    const cur = this.balanceAdmissionFloor.get(userId);
    if (cur == null || micro > cur) this.balanceAdmissionFloor.set(userId, micro);
  }

  // ---------------------------------------------------------------------------
  // 计费与结算
  // ---------------------------------------------------------------------------
  private async computeCostForProvider(
    providerId: number,
    modelName: string,
    pt: number,
    ct: number,
    cache: number,
    searchRequests: number,
    at: Date,
  ): Promise<number> {
    const inputs = await this.loadPriceInputs(providerId, modelName);
    const base = costOfAt(
      at,
      pt,
      ct,
      cache,
      inputs.input,
      inputs.output,
      inputs.cache,
      inputs.offpeak,
      inputs.windows,
    );
    return base + searchFee(searchRequests, inputs.searchPer1K);
  }

  /** 一次性计量：写 usage 行 + 扣余额 + 写 balance_ledger（单事务）。 */
  private async recordUsageAndSettle(
    userId: number,
    providerId: number,
    modelName: string,
    pt: number,
    ct: number,
    cache: number,
    searchRequests: number,
    kind: UsageKind,
    estimated: boolean,
  ): Promise<number> {
    const now = new Date();
    const cost = await this.computeCostForProvider(providerId, modelName, pt, ct, cache, searchRequests, now);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(usage)
        .values({
          userId,
          model: modelName,
          providerId,
          promptTokens: pt,
          completionTokens: ct,
          cachePromptTokens: cache,
          searchRequests,
          kind,
          cost: roundMicro(cost),
          estimated,
          createdAt: now,
        })
        .returning({ id: usage.id });
      await this.settleUsageCostTx(tx, row.id, userId, cost, false);
      return row.id;
    });
  }

  /** 流式：先落 0-token 待结行，稍后回填 + 差额结算。 */
  private async beginStreamUsage(userId: number, modelName: string, kind: UsageKind): Promise<number> {
    const [row] = await this.db
      .insert(usage)
      .values({
        userId,
        model: modelName,
        providerId: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachePromptTokens: 0,
        searchRequests: 0,
        kind,
        cost: 0,
        estimated: true,
      })
      .returning({ id: usage.id });
    return row.id;
  }

  private async deleteUsage(usageId: number): Promise<void> {
    await this.db.delete(usage).where(eq(usage.id, usageId));
  }

  private async setUsageProvider(usageId: number, providerId: number): Promise<void> {
    await this.db.update(usage).set({ providerId }).where(eq(usage.id, usageId));
  }

  private async finalizeStreamUsage(
    usageId: number,
    userId: number,
    providerId: number,
    modelName: string,
    pt: number,
    ct: number,
    cache: number,
    searchRequests: number,
    estimated: boolean,
  ): Promise<void> {
    const [row] = await this.db.select().from(usage).where(eq(usage.id, usageId)).limit(1);
    if (!row) return;
    const cost = await this.computeCostForProvider(
      providerId,
      modelName,
      pt,
      ct,
      cache,
      searchRequests,
      row.createdAt,
    );
    await this.db.transaction(async (tx) => {
      await tx
        .update(usage)
        .set({
          providerId,
          promptTokens: pt,
          completionTokens: ct,
          cachePromptTokens: cache,
          searchRequests,
          cost: roundMicro(cost),
          estimated,
        })
        .where(eq(usage.id, usageId));
      await this.settleUsageCostTx(tx, usageId, userId, cost, true);
    });
  }

  /** 差额结算（幂等）：charged = 已扣 = -SUM(ledger.amount)。 */
  private async settleUsageCostTx(
    tx: Tx,
    usageId: number,
    userId: number,
    targetCost: number,
    allowOverdraft: boolean,
  ): Promise<void> {
    if (targetCost < 0 || Number.isNaN(targetCost) || !Number.isFinite(targetCost)) {
      throw new ApiError('INTERNAL', '费用计算异常');
    }
    const [chargedRow] = await tx
      .select({ total: sql<number>`coalesce(sum(${balanceLedger.amount})::float8, 0)` })
      .from(balanceLedger)
      .where(eq(balanceLedger.usageId, usageId));
    const charged = -(chargedRow?.total ?? 0);
    const delta = roundMicro(-(roundMicro(targetCost) - roundMicro(charged)));
    if (delta === 0) return;

    const updated = await tx
      .update(users)
      .set({
        balanceMoney: sql`${users.balanceMoney} + ${delta}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(users.id, userId),
          isNotNull(users.balanceActivatedAt),
          or(
            sql`${users.balanceMoney} + ${delta} >= ${-BALANCE_FLOOR_EPSILON}`,
            sql`${delta} >= 0`,
          ),
        ),
      )
      .returning({ balanceMoney: users.balanceMoney });

    if (updated.length === 0) {
      const [u] = await tx
        .select({ activated: users.balanceActivatedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (u?.activated != null) {
        throw new ApiError('BALANCE_EXHAUSTED', '余额不足,本次调用未完成:请联系管理员充值');
      }
      return; // 未开通余额：不扣。
    }

    const after = updated[0].balanceMoney;
    const kind: LedgerKind = delta < 0 ? 'consume' : 'refund';
    await tx.insert(balanceLedger).values({
      userId,
      kind,
      amount: roundMicro(delta),
      balanceAfter: roundMicro(after),
      reason: '',
      actor: 'system',
      usageId,
      month: '',
    });
  }

  // ---------------------------------------------------------------------------
  // 转发
  // ---------------------------------------------------------------------------
  private async forward(
    up: Upstream,
    body: Uint8Array,
    endpoint: Endpoint,
    protocol: 'openai' | 'anthropic',
    anthropicVersion: string | undefined,
  ): Promise<globalThis.Response | null> {
    const url = upstreamURL(up.baseUrl, endpoint);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (protocol === 'anthropic') {
      headers['x-api-key'] = up.apiKey;
      headers.Authorization = `Bearer ${up.apiKey}`;
      if (anthropicVersion) headers['anthropic-version'] = anthropicVersion;
    } else {
      headers.Authorization = `Bearer ${up.apiKey}`;
    }
    try {
      const resp = await fetch(url, { method: 'POST', headers, body: body as unknown as BodyInit });
      if (resp.status >= 500) {
        await resp.body?.cancel().catch(() => undefined);
        return null;
      }
      return resp;
    } catch (e) {
      this.logger.debug(`upstream ${up.name} forward failed: ${(e as Error).message}`);
      return null;
    }
  }

  private redactSecrets(text: string, secrets: string[]): string {
    let out = text;
    for (const s of secrets) {
      if (s.length >= 8 && out.includes(s)) out = out.split(s).join('***');
    }
    return out;
  }

  private sanitizeUpstreamError(body: string, secrets: string[]): string {
    const redacted = this.redactSecrets(body, secrets);
    try {
      const obj = JSON.parse(redacted);
      const err = (obj as Record<string, unknown>)?.error as Record<string, unknown> | undefined;
      if (err) {
        const out: Record<string, unknown> = {};
        if (typeof err.message === 'string') out.message = err.message;
        if (typeof err.type === 'string') out.type = err.type;
        if (typeof err.code === 'string') out.code = err.code;
        const s = JSON.stringify({ error: out });
        return s.length > 2048 ? JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: '上游请求失败' } }) : s;
      }
    } catch {
      // fallthrough
    }
    return JSON.stringify({ error: { code: 'UPSTREAM_ERROR', message: '上游请求失败' } });
  }

  // ---------------------------------------------------------------------------
  // 端点入口
  // ---------------------------------------------------------------------------
  async chatCompletions(user: User, raw: Buffer, res: ExpressResponse): Promise<void> {
    await this.acquireInflight(user.id);
    try {
      await this.rateLimitAllow(user.id);
      const obj = parseJsonObject(raw);
      const model = typeof obj.model === 'string' && obj.model ? obj.model : '';
      if (!model) throw new ApiError('VALIDATION', '请求体缺少 model 字段');
      const stream = obj.stream === true;
      const promptTokens = estimatePromptTokensFromBytes(raw.length);
      const refusal = await this.balanceAdmissionBlocked(user, model, promptTokens, 'chat', 'openai');
      if (refusal) {
        this.recordAdmissionRejection(user, 'chat', model, refusal.reason, refusal.requiredMicro ?? 0);
        throw new ApiError(refusal.code, refusal.message);
      }
      const candidates = await this.matchModelsByProtocol(model, 'openai');
      if (candidates.length === 0) throw new ApiError('NOT_FOUND', '模型不存在或不可用');
      await this.injectDefaultParams(obj, model);
      const end = this.beginConcurrency(model);
      let usageId: number | null = null;
      try {
        if (stream) usageId = await this.beginStreamUsage(user.id, model, 'chat');
        const body = this.prepareOutboundBody(obj, user.id, 'openai');
        const secrets = candidates.map((c) => c.apiKey);
        for (const up of candidates) {
          const resp = await this.forward(
            up,
            Buffer.from(JSON.stringify(body), 'utf8'),
            '/chat/completions',
            'openai',
            undefined,
          );
          if (!resp) continue;
          if (usageId != null) await this.setUsageProvider(usageId, up.id);
          if (stream) {
            await this.serveStream(res, resp, up, model, user.id, usageId!, 'openai', secrets);
          } else {
            await this.serveJSON(res, resp, up.id, model, user.id, usageId, 'chat', 'openai', secrets, 0);
          }
          return;
        }
        if (usageId != null) await this.deleteUsage(usageId);
        throw new ApiError('UPSTREAM', '上游服务不可用');
      } finally {
        end();
      }
    } finally {
      this.releaseInflight(user.id);
    }
  }

  async embeddings(user: User, raw: Buffer, res: ExpressResponse): Promise<void> {
    await this.acquireInflight(user.id);
    try {
      await this.rateLimitAllow(user.id);
      const obj = parseJsonObject(raw);
      const model = typeof obj.model === 'string' && obj.model ? obj.model : '';
      if (!model) throw new ApiError('VALIDATION', '请求体缺少 model 字段');
      const inputs = parseEmbeddingInputs(obj.input);
      if (inputs.length === 0) throw new ApiError('VALIDATION', '请求体缺少 input 字段');
      const promptTokens = estimateEmbeddingPromptTokens(inputs);
      const refusal = await this.balanceAdmissionBlocked(user, model, promptTokens, 'embeddings', 'openai');
      if (refusal) {
        this.recordAdmissionRejection(user, 'embeddings', model, refusal.reason, refusal.requiredMicro ?? 0);
        throw new ApiError(refusal.code, refusal.message);
      }
      const candidates = await this.matchModelsByProtocol(model, 'openai');
      if (candidates.length === 0) throw new ApiError('NOT_FOUND', '模型不存在或不可用');
      const end = this.beginConcurrency(model);
      try {
        // 服务端重建 {model,input}，不透传原请求体。
        const body = JSON.stringify({ model, input: obj.input });
        let lastResp: globalThis.Response | null = null;
        let lastUp: Upstream | null = null;
        for (const up of candidates) {
          const resp = await this.forward(up, Buffer.from(body, 'utf8'), '/embeddings', 'openai', undefined);
          if (!resp) continue;
          lastResp = resp;
          lastUp = up;
          break;
        }
        if (!lastResp || !lastUp) throw new ApiError('UPSTREAM', '上游服务不可用');
        await this.serveEmbeddings(res, lastResp, lastUp.id, model, user.id, inputs);
      } finally {
        end();
      }
    } finally {
      this.releaseInflight(user.id);
    }
  }

  async messages(user: User, raw: Buffer, res: ExpressResponse): Promise<void> {
    await this.acquireInflight(user.id);
    try {
      await this.rateLimitAllow(user.id);
      const obj = parseJsonObject(raw);
      const model = typeof obj.model === 'string' && obj.model ? obj.model : '';
      if (!model) throw new ApiError('VALIDATION', '请求体缺少 model 字段');
      const stream = obj.stream === true;
      const promptTokens = estimatePromptTokensFromBytes(raw.length);
      const refusal = await this.balanceAdmissionBlocked(user, model, promptTokens, 'messages', 'anthropic');
      if (refusal) {
        this.recordAdmissionRejection(user, 'messages', model, refusal.reason, refusal.requiredMicro ?? 0);
        throw new ApiError(refusal.code, refusal.message);
      }
      const candidates = await this.matchModelsByProtocol(model, 'anthropic');
      if (candidates.length === 0) throw new ApiError('NOT_FOUND', '模型不存在或不可用');
      const end = this.beginConcurrency(model);
      let usageId: number | null = null;
      try {
        if (stream) usageId = await this.beginStreamUsage(user.id, model, 'chat');
        const body = this.prepareOutboundBody(obj, user.id, 'anthropic');
        const anthropicVersion = typeof obj['anthropic-version'] === 'string' ? (obj['anthropic-version'] as string) : undefined;
        const secrets = candidates.map((c) => c.apiKey);
        for (const up of candidates) {
          const resp = await this.forward(
            up,
            Buffer.from(JSON.stringify(body), 'utf8'),
            '/messages',
            'anthropic',
            anthropicVersion,
          );
          if (!resp) continue;
          if (usageId != null) await this.setUsageProvider(usageId, up.id);
          if (stream) {
            await this.serveStream(res, resp, up, model, user.id, usageId!, 'anthropic', secrets);
          } else {
            await this.serveJSON(res, resp, up.id, model, user.id, usageId, 'chat', 'anthropic', secrets, 0);
          }
          return;
        }
        if (usageId != null) await this.deleteUsage(usageId);
        throw new ApiError('UPSTREAM', '上游服务不可用');
      } finally {
        end();
      }
    } finally {
      this.releaseInflight(user.id);
    }
  }

  async completions(user: User, raw: Buffer, res: ExpressResponse): Promise<void> {
    await this.acquireInflight(user.id);
    try {
      await this.rateLimitAllow(user.id);
      const obj = parseJsonObject(raw);
      const model = typeof obj.model === 'string' && obj.model ? obj.model : '';
      if (!model) throw new ApiError('VALIDATION', '请求体缺少 model 字段');
      if (obj.prompt == null || obj.prompt === '') {
        throw new ApiError('VALIDATION', '请求体缺少 prompt 字段');
      }
      const stream = obj.stream === true;
      const promptTokens = estimatePromptTokensFromBytes(raw.length);
      const refusal = await this.balanceAdmissionBlocked(user, model, promptTokens, 'completions', 'openai');
      if (refusal) {
        this.recordAdmissionRejection(user, 'completions', model, refusal.reason, refusal.requiredMicro ?? 0);
        throw new ApiError(refusal.code, refusal.message);
      }
      const candidates = await this.matchModelsByProtocol(model, 'openai');
      if (candidates.length === 0) throw new ApiError('NOT_FOUND', '模型不存在或不可用');
      await this.injectDefaultParams(obj, model);
      const end = this.beginConcurrency(model);
      let usageId: number | null = null;
      try {
        if (stream) usageId = await this.beginStreamUsage(user.id, model, 'chat');
        const body = this.prepareOutboundBody(obj, user.id, 'none');
        const secrets = candidates.map((c) => c.apiKey);
        for (const up of candidates) {
          const resp = await this.forward(up, Buffer.from(JSON.stringify(body), 'utf8'), '/completions', 'openai', undefined);
          if (!resp) continue;
          if (usageId != null) await this.setUsageProvider(usageId, up.id);
          if (stream) {
            await this.serveStream(res, resp, up, model, user.id, usageId!, 'openai', secrets);
          } else {
            await this.serveJSON(res, resp, up.id, model, user.id, usageId, 'chat', 'openai', secrets, 0);
          }
          return;
        }
        if (usageId != null) await this.deleteUsage(usageId);
        throw new ApiError('UPSTREAM', '上游服务不可用');
      } finally {
        end();
      }
    } finally {
      this.releaseInflight(user.id);
    }
  }

  async responses(user: User, raw: Buffer, res: ExpressResponse): Promise<void> {
    await this.acquireInflight(user.id);
    try {
      await this.rateLimitAllow(user.id);
      const obj = parseJsonObject(raw);
      const model = typeof obj.model === 'string' && obj.model ? obj.model : '';
      if (!model) throw new ApiError('VALIDATION', '请求体缺少 model 字段');
      if (obj.input == null) throw new ApiError('VALIDATION', '请求体缺少 input 字段');
      const stream = obj.stream === true;
      const promptTokens = estimatePromptTokensFromBytes(raw.length);
      const refusal = await this.balanceAdmissionBlocked(user, model, promptTokens, 'responses', 'openai');
      if (refusal) {
        this.recordAdmissionRejection(user, 'responses', model, refusal.reason, refusal.requiredMicro ?? 0);
        throw new ApiError(refusal.code, refusal.message);
      }
      const candidates = await this.matchModelsByProtocol(model, 'openai');
      if (candidates.length === 0) throw new ApiError('NOT_FOUND', '模型不存在或不可用');
      await this.injectDefaultParams(obj, model);
      const end = this.beginConcurrency(model);
      let usageId: number | null = null;
      try {
        if (stream) usageId = await this.beginStreamUsage(user.id, model, 'chat');
        const body = this.prepareOutboundBody(obj, user.id, 'responses');
        const secrets = candidates.map((c) => c.apiKey);
        for (const up of candidates) {
          const resp = await this.forward(up, Buffer.from(JSON.stringify(body), 'utf8'), '/responses', 'openai', undefined);
          if (!resp) continue;
          if (usageId != null) await this.setUsageProvider(usageId, up.id);
          if (stream) {
            await this.serveStream(res, resp, up, model, user.id, usageId!, 'openai', secrets);
          } else {
            await this.serveJSON(res, resp, up.id, model, user.id, usageId, 'chat', 'openai', secrets, 0);
          }
          return;
        }
        if (usageId != null) await this.deleteUsage(usageId);
        throw new ApiError('UPSTREAM', '上游服务不可用');
      } finally {
        end();
      }
    } finally {
      this.releaseInflight(user.id);
    }
  }

  async listModels(): Promise<{ models: Array<{ id: string; display_name: string; default_params: string; input_modalities: string[] }> }> {
    const rows = await this.db
      .select({
        name: models.name,
        displayName: models.displayName,
        defaultParams: models.defaultParams,
        inputModalities: models.inputModalities,
      })
      .from(models)
      .innerJoin(gatewayProviders, eq(models.providerId, gatewayProviders.id))
      .where(and(eq(gatewayProviders.enabled, 1), eq(models.catalogMissing, false)))
      .orderBy(models.id);
    return {
      models: rows.map((r) => ({
        id: r.name,
        display_name: r.displayName ?? r.name,
        default_params: r.defaultParams || '',
        input_modalities: safeParseStringArray(r.inputModalities),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 出站体加工
  // ---------------------------------------------------------------------------
  private prepareOutboundBody(
    obj: Record<string, unknown>,
    userId: number,
    identity: Identity,
  ): Record<string, unknown> {
    const out = stripUpstreamExtensions(obj);
    const uid = `u${userId}`;
    if (identity === 'openai') out.user_id = uid;
    else if (identity === 'responses') out.user = uid;
    else if (identity === 'anthropic') {
      let meta = out.metadata as Record<string, unknown> | undefined;
      if (meta == null) {
        meta = {};
        out.metadata = meta;
      }
      if (typeof meta !== 'object' || Array.isArray(meta)) {
        throw new ApiError('VALIDATION', 'metadata 必须是 JSON 对象');
      }
      meta.user_id = uid;
    }
    return out;
  }

  /** 从 default_params 注入 max_tokens（缺省时）。 */
  private async injectDefaultParams(obj: Record<string, unknown>, model: string): Promise<void> {
    const params = await this.modelDefaultParams(model);
    const maxOutput = params.max_output ?? params.max_tokens ?? params.max_output_tokens;
    if (typeof maxOutput === 'number' && maxOutput > 0) {
      if (obj.max_tokens == null && obj.max_completion_tokens == null) {
        obj.max_tokens = maxOutput;
      }
    }
    // 流式时强制 stream_options.include_usage=true（非 Anthropic）。
    if (obj.stream === true && !obj.stream_options) {
      obj.stream_options = { include_usage: true };
    }
  }

  // ---------------------------------------------------------------------------
  // 响应回写
  // ---------------------------------------------------------------------------
  private async serveJSON(
    res: ExpressResponse,
    upstreamResp: globalThis.Response,
    providerId: number,
    model: string,
    userId: number,
    usageId: number | null,
    kind: UsageKind,
    protocol: 'openai' | 'anthropic',
    secrets: string[],
    searchRequests: number,
  ): Promise<void> {
    const buf = await readLimitedBody(upstreamResp, MAX_UPSTREAM_BODY);
    if (buf === null) {
      if (usageId != null) await this.deleteUsage(usageId);
      throw new ApiError('UPSTREAM', '上游响应过大');
    }
    const text = buf.toString('utf8');
    const redacted = this.redactSecrets(text, secrets);
    const status = upstreamResp.status;

    this.copyPassHeaders(res, upstreamResp);
    if (status >= 400) {
      if (usageId != null) await this.deleteUsage(usageId);
      res.status(status).end(this.sanitizeUpstreamError(redacted, secrets));
      return;
    }

    let pt = 0;
    let ct = 0;
    let cache = 0;
    let estimated = false;
    let search = searchRequests;
    if (protocol === 'anthropic') {
      const u = parseAnthropicUsage(redacted);
      pt = u.pt;
      ct = u.ct;
      cache = u.cache;
    } else {
      const u = parseOpenAIUsage(redacted);
      pt = u.pt;
      ct = u.ct;
      cache = u.cache;
    }
    // 补全估算回退。
    if (ct <= 0 && text.length > 0) {
      const e = estimateCompletionTokens(0, text.length);
      ct = e.tokens;
      estimated = e.estimated;
    }
    if (pt <= 0 && text.length > 0) {
      pt = estimatePromptTokensFromBytes(text.length);
      estimated = true;
    }
    if (protocol === 'anthropic') search = countWebSearches(tryParse(redacted));

    try {
      await this.recordUsageAndSettle(userId, providerId, model, pt, ct, cache, search, kind, estimated);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BALANCE_EXHAUSTED') {
        this.raiseAdmissionFloor(userId, 0);
        res
          .status(429)
          .json({ error: { code: 'BALANCE_EXHAUSTED', message: '余额不足,本次调用未完成:请联系管理员充值' } });
      } else {
        res
          .status(503)
          .json({ error: { code: 'METERING_FAILED', message: '计量结算失败,本次调用未完成:请稍后重试' } });
      }
      return;
    }
    res.status(status).end(redacted);
  }

  private async serveEmbeddings(
    res: ExpressResponse,
    upstreamResp: globalThis.Response,
    providerId: number,
    model: string,
    userId: number,
    inputs: string[],
  ): Promise<void> {
    const buf = await readLimitedBody(upstreamResp, MAX_UPSTREAM_BODY);
    if (buf === null) throw new ApiError('UPSTREAM', '上游响应过大');
    const text = buf.toString('utf8');
    this.copyPassHeaders(res, upstreamResp);
    if (upstreamResp.status >= 400) {
      res.status(upstreamResp.status).end(this.sanitizeUpstreamError(text, []));
      return;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text) as Record<string, unknown>;
    } catch {
      obj = {};
    }
    const usageRec = (obj.usage ?? {}) as Record<string, unknown>;
    let tokens = usageValue(usageRec.total_tokens, usageRec.prompt_tokens);
    let estimated = false;
    if (tokens <= 0) {
      tokens = estimateEmbeddingPromptTokens(inputs);
      estimated = true;
    }
    try {
      await this.recordUsageAndSettle(userId, providerId, model, tokens, 0, 0, 0, 'embedding', estimated);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'BALANCE_EXHAUSTED') {
        res
          .status(429)
          .json({ error: { code: 'BALANCE_EXHAUSTED', message: '余额不足,本次调用未完成:请联系管理员充值' } });
      } else {
        res
          .status(503)
          .json({ error: { code: 'METERING_FAILED', message: '计量结算失败,本次调用未完成:请稍后重试' } });
      }
      return;
    }
    res.status(upstreamResp.status).end(text);
  }

  private async serveStream(
    res: ExpressResponse,
    upstreamResp: globalThis.Response,
    up: Upstream,
    model: string,
    userId: number,
    usageId: number,
    protocol: 'openai' | 'anthropic',
    secrets: string[],
  ): Promise<void> {
    const status = upstreamResp.status;
    if (status >= 400) {
      const buf = await readLimitedBody(upstreamResp, MAX_UPSTREAM_BODY);
      await this.deleteUsage(usageId);
      const text = buf ? buf.toString('utf8') : '';
      res.status(status).end(this.sanitizeUpstreamError(text, secrets));
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const body = upstreamResp.body;
    if (!body) {
      await this.deleteUsage(usageId);
      res.end();
      return;
    }

    let reportedPT = 0;
    let reportedCT = 0;
    let reportedCache = 0;
    let search = 0;
    let terminalSeen = false;
    let contentBytes = 0;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          const wrote = this.handleStreamLine(
            res,
            line,
            protocol,
            (u) => {
              reportedPT = Math.max(reportedPT, u.pt);
              reportedCT = Math.max(reportedCT, u.ct);
              reportedCache = Math.max(reportedCache, u.cache);
              if (protocol === 'anthropic') search = Math.max(search, countWebSearches(tryParse(stripDataPrefix(line))));
            },
            () => {
              terminalSeen = true;
            },
          );
          if (wrote) contentBytes += Buffer.byteLength(line, 'utf8');
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 流结束：回填缺失侧 + 结算。
    if (reportedCT <= 0 && contentBytes > 0) {
      const e = estimateCompletionTokens(0, contentBytes);
      reportedCT = e.tokens;
    }
    if (reportedPT <= 0) {
      reportedPT = estimatePromptTokensFromBytes(contentBytes);
    }
    try {
      await this.finalizeStreamUsage(
        usageId,
        userId,
        up.id,
        model,
        reportedPT,
        reportedCT,
        reportedCache,
        search,
        true,
      );
    } catch (e) {
      const body = res as unknown as { write: (s: string) => void };
      if (e instanceof ApiError && e.code === 'BALANCE_EXHAUSTED') {
        body.write('data: {"error":{"code":"BALANCE_EXHAUSTED","message":"余额不足,本次调用未完成:请联系管理员充值"}}\n\n');
      } else {
        body.write('data: {"error":{"code":"METERING_FAILED","message":"计量结算失败,本次调用未完成:请稍后重试"}}\n\n');
      }
    }
    res.end();
  }

  /** 处理单行流：返回是否写入了内容。 */
  private handleStreamLine(
    res: ExpressResponse,
    line: string,
    protocol: 'openai' | 'anthropic',
    onUsage: (u: { pt: number; ct: number; cache: number }) => void,
    onTerminal: () => void,
  ): boolean {
    if (line.length === 0) {
      res.write('\n');
      return false;
    }
    if (protocol === 'openai' && line === 'data: [DONE]') {
      res.write(line + '\n');
      onTerminal();
      return false;
    }
    if (protocol === 'anthropic' && line === 'event: message_stop') {
      res.write(line + '\n');
      onTerminal();
      return false;
    }
    if (line.startsWith('data:')) {
      const u = protocol === 'anthropic' ? parseAnthropicUsage(line) : parseOpenAIUsage(line);
      if (u.ok) onUsage(u);
      if (isTerminalData(line, protocol)) onTerminal();
    }
    res.write(line + '\n');
    return true;
  }

  private copyPassHeaders(res: ExpressResponse, upstreamResp: globalThis.Response): void {
    for (const h of PASS_HEADERS) {
      const v = upstreamResp.headers.get(h);
      if (v) res.setHeader(h, v);
    }
  }

  // ---------------------------------------------------------------------------
  // Admin surface: gateway config / error reporting / concurrency
  // ---------------------------------------------------------------------------

  async getGatewayConfig(): Promise<Record<string, unknown>> {
    const m = await this.settings.getMany([
      'gateway.default_model',
      'gateway.rate_limit',
      'usage.peak_windows',
      'usage.search_price_per_1k',
      'usage.retention_months',
      'web.error_reporting_dsn',
      'web.error_reporting_enabled',
      'web.error_reporting_level',
      'web.error_reporting_heartbeat',
      'web.glitchtip_base_url',
      'web.glitchtip_organization',
      'web.default_thinking_level',
      'server.base_url',
      'gateway.max_file_refs',
      'gateway.body_parse_budget_mb',
      'gateway.file_expiry_days',
      'gateway.unpriced_model_policy',
    ]);
    const s = (k: string): string => m.get(k) ?? '';
    const boolOf = (v: string | undefined): boolean => v === 'true' || v === '1';
    return {
      default_model: s('gateway.default_model'),
      rate_limit: m.get('gateway.rate_limit') ?? '0',
      peak_windows: s('usage.peak_windows'),
      search_price_per_1k: m.get('usage.search_price_per_1k') ?? '0',
      retention_months: m.get('usage.retention_months') ?? '6',
      error_reporting_dsn: s('web.error_reporting_dsn'),
      error_reporting_enabled: boolOf(m.get('web.error_reporting_enabled')),
      error_reporting_level: s('web.error_reporting_level'),
      error_reporting_heartbeat: boolOf(m.get('web.error_reporting_heartbeat')),
      glitchtip_base_url: s('web.glitchtip_base_url'),
      glitchtip_organization: s('web.glitchtip_organization'),
      default_thinking_level: s('web.default_thinking_level'),
      server_base_url: s('server.base_url'),
      max_file_refs: m.get('gateway.max_file_refs') ?? '600',
      body_parse_budget_mb: m.get('gateway.body_parse_budget_mb') ?? '128',
      file_expiry_days: m.get('gateway.file_expiry_days') ?? '7',
      unpriced_model_policy: m.get('gateway.unpriced_model_policy') ?? 'reject',
    };
  }

  async setGatewayConfig(
    adminUsername: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; warnings: string[] }> {
    const changes: string[] = [];
    const numOf = (v: unknown, field: string): number | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v === 'number') return v;
      if (typeof v === 'string') {
        if (v === '') return undefined;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new ApiError('VALIDATION', `${field} 必须是数值`);
        return n;
      }
      throw new ApiError('VALIDATION', `${field} 必须是数值`);
    };
    const intOf = (v: unknown, field: string): number | undefined => {
      const n = numOf(v, field);
      if (n === undefined) return undefined;
      if (!Number.isInteger(n)) throw new ApiError('VALIDATION', `${field} 必须是整数`);
      return n;
    };

    // ---- validate before writing anything ----
    const rateLimit = intOf(body.rate_limit, 'rate_limit');
    if (rateLimit !== undefined && (rateLimit < 0 || rateLimit > 100000)) {
      throw new ApiError('VALIDATION', 'rate_limit 必须是 0~100000 的整数(0=不限制)');
    }
    const searchPrice = numOf(body.search_price_per_1k, 'search_price_per_1k');
    if (searchPrice !== undefined && (searchPrice < 0 || searchPrice > 1000)) {
      throw new ApiError('VALIDATION', 'search_price_per_1k 必须是 0~1000 的数值(元/千次成功搜索,0=不计费)');
    }
    const maxFileRefs = intOf(body.max_file_refs, 'max_file_refs');
    if (maxFileRefs !== undefined && (maxFileRefs < 1 || maxFileRefs > 4096)) {
      throw new ApiError('VALIDATION', 'max_file_refs 必须是 1~4096 的整数');
    }
    const budgetMB = intOf(body.body_parse_budget_mb, 'body_parse_budget_mb');
    if (budgetMB !== undefined && (budgetMB < 64 || budgetMB > 8192)) {
      throw new ApiError('VALIDATION', 'body_parse_budget_mb 必须是 64~8192 的整数(MiB)');
    }
    const fileExpiry = intOf(body.file_expiry_days, 'file_expiry_days');
    if (fileExpiry !== undefined && (fileExpiry < 1 || fileExpiry > 30)) {
      throw new ApiError('VALIDATION', 'file_expiry_days 必须是 1~30 的整数(天)');
    }
    const retention = intOf(body.retention_months, 'retention_months');
    if (retention !== undefined && (retention < 0 || retention > 120)) {
      throw new ApiError('VALIDATION', 'retention_months 必须是 0~120 的整数(0=永久)');
    }
    const unpricedPolicy = typeof body.unpriced_model_policy === 'string' ? body.unpriced_model_policy : undefined;
    if (unpricedPolicy !== undefined && unpricedPolicy !== 'reject' && unpricedPolicy !== 'allow') {
      throw new ApiError('VALIDATION', 'unpriced_model_policy 必须是 reject 或 allow');
    }
    const level = typeof body.error_reporting_level === 'string' ? body.error_reporting_level : undefined;
    if (level !== undefined && !['error', 'warning', 'info', 'debug'].includes(level)) {
      throw new ApiError('VALIDATION', 'error_reporting_level 必须是 error|warning|info|debug');
    }
    const thinking = typeof body.default_thinking_level === 'string' ? body.default_thinking_level : undefined;
    if (thinking !== undefined && !['off', 'low', 'high', 'max'].includes(thinking)) {
      throw new ApiError('VALIDATION', 'default_thinking_level 必须是 off|low|high|max');
    }
    if (body.peak_windows !== undefined && typeof body.peak_windows === 'string' && body.peak_windows !== '') {
      const windows = parsePeakWindows(body.peak_windows);
      if (windows === null) {
        throw new ApiError('VALIDATION', 'peak_windows 格式错误(应为 [{start,end,weekdays?}] 数组)');
      }
    }
    if (body.default_model !== undefined && typeof body.default_model === 'string' && body.default_model !== '') {
      const matched = await this.db
        .select({ n: models.name })
        .from(models)
        .innerJoin(gatewayProviders, eq(models.providerId, gatewayProviders.id))
        .where(and(eq(models.name, body.default_model), eq(models.catalogMissing, false), eq(gatewayProviders.enabled, 1)))
        .limit(1);
      if (matched.length === 0) {
        throw new ApiError('VALIDATION', '默认模型必须属于已启用的模型');
      }
    }

    // ---- DSN admission (reject on invalid, warn on http/private) ----
    let warnings: string[] = [];
    if (body.error_reporting_dsn !== undefined && typeof body.error_reporting_dsn === 'string') {
      const insp = inspectErrorReportingDSN(body.error_reporting_dsn);
      if (insp.verdict === 'reject') {
        throw new ApiError('VALIDATION', insp.message);
      }
      if (insp.message) warnings.push(insp.message);
    }
    const enabledNow =
      body.error_reporting_enabled === true
        ? true
        : body.error_reporting_enabled === undefined
          ? (await this.settings.get('web.error_reporting_enabled')) === 'true'
          : false;
    const dsnNow =
      typeof body.error_reporting_dsn === 'string'
        ? body.error_reporting_dsn
        : (await this.settings.get('web.error_reporting_dsn')) ?? '';
    if (enabledNow && dsnNow === '') {
      throw new ApiError('VALIDATION', '启用客户端错误上报时必须填写 DSN(错误上报地址)');
    }

    // ---- write (all validated) ----
    const setStr = async (key: string, label: string, value: string): Promise<void> => {
      await this.settings.set(key, value);
      changes.push(label);
    };
    if (body.default_model !== undefined) await setStr('gateway.default_model', 'default_model', String(body.default_model));
    if (body.rate_limit !== undefined) await setStr('gateway.rate_limit', 'rate_limit', String(rateLimit));
    if (body.peak_windows !== undefined) await setStr('usage.peak_windows', 'peak_windows', String(body.peak_windows));
    if (body.search_price_per_1k !== undefined) await setStr('usage.search_price_per_1k', 'search_price_per_1k', String(searchPrice));
    if (body.retention_months !== undefined) await setStr('usage.retention_months', 'retention_months', String(retention));
    if (body.error_reporting_dsn !== undefined) await setStr('web.error_reporting_dsn', 'error_reporting_dsn', String(body.error_reporting_dsn));
    if (body.error_reporting_enabled !== undefined) await setStr('web.error_reporting_enabled', 'error_reporting_enabled', String(!!body.error_reporting_enabled));
    if (body.error_reporting_level !== undefined) await setStr('web.error_reporting_level', 'error_reporting_level', String(body.error_reporting_level));
    if (body.error_reporting_heartbeat !== undefined) await setStr('web.error_reporting_heartbeat', 'error_reporting_heartbeat', String(!!body.error_reporting_heartbeat));
    if (body.glitchtip_base_url !== undefined) await setStr('web.glitchtip_base_url', 'glitchtip_base_url', String(body.glitchtip_base_url));
    if (body.glitchtip_organization !== undefined) await setStr('web.glitchtip_organization', 'glitchtip_organization', String(body.glitchtip_organization));
    if (body.default_thinking_level !== undefined) await setStr('web.default_thinking_level', 'default_thinking_level', String(body.default_thinking_level));
    if (body.server_base_url !== undefined) await setStr('server.base_url', 'server_base_url', String(body.server_base_url));
    if (body.max_file_refs !== undefined) await setStr('gateway.max_file_refs', 'max_file_refs', String(maxFileRefs));
    if (body.body_parse_budget_mb !== undefined) await setStr('gateway.body_parse_budget_mb', 'body_parse_budget_mb', String(budgetMB));
    if (body.file_expiry_days !== undefined) await setStr('gateway.file_expiry_days', 'file_expiry_days', String(fileExpiry));
    if (unpricedPolicy !== undefined) await setStr('gateway.unpriced_model_policy', 'unpriced_model_policy', unpricedPolicy);

    if (changes.length > 0) {
      await this.audit.log(adminUsername, 'gateway_config', changes.join(', '));
    }
    return { ok: true, warnings };
  }

  async concurrencyStatus(): Promise<{ checked_at: string; models: Array<Record<string, unknown>> }> {
    const snapshot = this.snapshotConcurrency();
    const since = new Date(Date.now() - 90 * 24 * 3600 * 1000);
    const peaks = await this.peakConcurrencyByModel(since);
    const rows = await this.db
      .select({ name: models.name, defaultParams: models.defaultParams, providerName: gatewayProviders.name })
      .from(models)
      .innerJoin(gatewayProviders, eq(models.providerId, gatewayProviders.id));
    const info = new Map<string, { target: number; provider: string }>();
    for (const r of rows) {
      const params = safeParseObject(r.defaultParams);
      const t = typeof params.concurrency_target === 'number' ? (params.concurrency_target as number) : 0;
      info.set(r.name, { target: Math.max(0, Math.floor(t)), provider: r.providerName });
    }
    const keys = new Set<string>([...snapshot.keys(), ...peaks.keys()]);
    const out = [...keys].map((model) => ({
      model,
      current: snapshot.get(model) ?? 0,
      peak_90d: peaks.get(model) ?? 0,
      target: info.get(model)?.target ?? 0,
      provider: info.get(model)?.provider,
    }));
    out.sort((a, b) => {
      const pd = (b.peak_90d as number) - (a.peak_90d as number);
      if (pd !== 0) return pd;
      const cd = (b.current as number) - (a.current as number);
      if (cd !== 0) return cd;
      return (a.model as string) < (b.model as string) ? -1 : 1;
    });
    return { checked_at: rfc3339UTC(new Date()), models: out };
  }

  async errorReportingClients(): Promise<Record<string, unknown>> {
    const items = await this.db
      .select({
        username: users.username,
        state: clientErrorReportingStatus.state,
        reason: clientErrorReportingStatus.reason,
        dsnHost: clientErrorReportingStatus.dsnHost,
        level: clientErrorReportingStatus.level,
        release: clientErrorReportingStatus.release,
        updatedAt: clientErrorReportingStatus.updatedAt,
      })
      .from(clientErrorReportingStatus)
      .innerJoin(users, eq(clientErrorReportingStatus.userId, users.id))
      .orderBy(desc(clientErrorReportingStatus.updatedAt))
      .limit(100);
    const counts = await this.db
      .select({ state: clientErrorReportingStatus.state, c: sql<number>`count(*)::int` })
      .from(clientErrorReportingStatus)
      .groupBy(clientErrorReportingStatus.state);
    const countMap = new Map<string, number>();
    let total = 0;
    for (const c of counts) {
      countMap.set(c.state, c.c);
      total += c.c;
    }
    const mapped = items.map((it) => ({
      username: it.username,
      state: it.state,
      reason: it.reason,
      dsn_host: it.dsnHost,
      level: it.level,
      release: it.release,
      updated_at: it.updatedAt ? rfc3339UTC(new Date(it.updatedAt)) : null,
    }));
    return {
      ready: countMap.get('ready') ?? 0,
      disabled: countMap.get('disabled') ?? 0,
      failed: countMap.get('failed') ?? 0,
      config_unavailable: countMap.get('config_unavailable') ?? 0,
      idle: countMap.get('idle') ?? 0,
      last_report_at: mapped.length > 0 ? mapped[0].updated_at : null,
      total,
      items: mapped,
    };
  }

  async errorReportingTest(
    adminUsername: string,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; payload: Record<string, unknown> }> {
    if (body.dsn !== undefined && typeof body.dsn === 'string' && body.dsn === '') {
      throw new ApiError('VALIDATION', 'dsn 不能为空(省略该字段才会使用已保存的 DSN)');
    }
    const dsnValue =
      typeof body.dsn === 'string' && body.dsn !== ''
        ? body.dsn
        : (await this.settings.get('web.error_reporting_dsn')) ?? '';
    if (!dsnValue) {
      throw new ApiError('VALIDATION', '尚未配置错误上报 DSN,无法发送测试事件');
    }
    const insp = inspectErrorReportingDSN(dsnValue);
    if (insp.verdict === 'reject') {
      throw new ApiError('VALIDATION', insp.message);
    }
    const eventId = this.crypto.randomHex(16);
    const started = Date.now();
    let httpStatus: number | undefined;
    let kind = 'UNKNOWN';
    try {
      const resp = await fetch(insp.storeEndpoint!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${insp.publicKey}, sentry_client=picoaide-server/0.1.0`,
        },
        body: JSON.stringify({
          event_id: eventId,
          timestamp: rfc3339UTC(new Date()),
          level: 'error',
          platform: 'other',
          release: 'picoaide-server',
          message: 'PicoAide 管理端连通性自检',
          tags: { 'picoaide.source': 'webadmin-test-event' },
        }),
        signal: AbortSignal.timeout(8000),
      });
      httpStatus = resp.status;
      await resp.body?.cancel().catch(() => undefined);
      if (resp.status >= 200 && resp.status < 300) kind = 'OK';
      else if (resp.status >= 500) kind = 'HTTP_5XX';
      else if (resp.status >= 400) kind = 'HTTP_4XX';
      else if (resp.status >= 300) kind = 'HTTP_3XX';
    } catch (e) {
      kind = classifyFetchError(e);
    }
    const elapsedMs = Date.now() - started;
    const note = '本结果由服务端发起,证明服务端到上报地址可达;员工客户端的网络环境可能不同';
    await this.audit.log(
      adminUsername,
      'error_reporting_test',
      kind === 'OK' ? `endpoint=${insp.storeEndpoint} ok http=${httpStatus}` : `endpoint=${insp.storeEndpoint} kind=${kind}`,
    );
    if (kind === 'OK') {
      return {
        ok: true,
        status: 200,
        payload: {
          ok: true,
          event_id: eventId,
          http_status: httpStatus,
          endpoint: insp.storeEndpoint,
          elapsed_ms: elapsedMs,
          note,
        },
      };
    }
    return {
      ok: false,
      status: 502,
      payload: {
        error: { code: 'UPSTREAM', message: '错误上报连通性自检失败' },
        detail: {
          kind,
          endpoint: insp.storeEndpoint,
          note,
          http_status: httpStatus,
          elapsed_ms: elapsedMs,
        },
      },
    };
  }
}

function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function safeParseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(stripDataPrefix(raw));
  } catch {
    return undefined;
  }
}

function parseEmbeddingInputs(input: unknown): string[] {
  if (typeof input === 'string') return [input];
  if (Array.isArray(input)) {
    return input.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

function isTerminalData(line: string, protocol: 'openai' | 'anthropic'): boolean {
  const text = stripDataPrefix(line);
  if (protocol === 'anthropic') {
    if (text.startsWith('event: message_stop')) return true;
    if (!text.startsWith('{')) return false;
    const o = tryParse(text) as Record<string, unknown> | undefined;
    return o?.type === 'message_stop' || o?.type === 'message_delta' ? (o as Record<string, unknown>).stop_reason != null : false;
  }
  if (!text.startsWith('{')) return false;
  const o = tryParse(text) as Record<string, unknown> | undefined;
  if (!o) return false;
  if (o.choices) {
    const choices = o.choices as Array<Record<string, unknown>>;
    return choices.some((c) => c.finish_reason != null && c.finish_reason !== '');
  }
  return false;
}

async function readLimitedBody(
  resp: globalThis.Response,
  max: number,
): Promise<Buffer | null> {
  const body = resp.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) return null;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

interface DsnInspection {
  verdict: 'accept' | 'warn' | 'reject';
  message: string;
  storeEndpoint?: string;
  publicKey?: string;
}

function inspectErrorReportingDSN(raw: string): DsnInspection {
  const dsn = raw.trim();
  if (!dsn) return { verdict: 'reject', message: '错误上报 DSN 不能为空' };
  if (dsn.length > 2048) return { verdict: 'reject', message: '错误上报 DSN 过长' };
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/@]+)@([^/]+)\/?(.*)$/i.exec(dsn);
  if (!m) {
    return { verdict: 'reject', message: '错误上报 DSN 格式错误(应为 {协议}://{公钥}@{主机}/{项目ID})' };
  }
  const scheme = m[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return { verdict: 'reject', message: '错误上报 DSN 必须以 http:// 或 https:// 开头' };
  }
  const publicKey = m[2];
  if (!/^[A-Za-z0-9_]+$/.test(publicKey)) {
    return { verdict: 'reject', message: '错误上报 DSN 的公钥只能包含字母/数字/下划线' };
  }
  const hostPort = m[3];
  const hp = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostPort);
  if (!hp) return { verdict: 'reject', message: '错误上报 DSN 的主机格式错误' };
  const host = hp[1];
  const port = hp[2] ?? '';
  if (port) {
    const p = parseInt(port, 10);
    if (p < 1 || p > 65535) return { verdict: 'reject', message: '错误上报 DSN 的端口无效' };
  }
  const path = m[4] ?? '';
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const pidMatch = /^\d+/.exec(last);
  if (!pidMatch) {
    return { verdict: 'reject', message: '错误上报 DSN 缺少项目 ID(格式:{协议}://{公钥}@{主机}/{项目ID})' };
  }
  const projectId = parseInt(pidMatch[0], 10);
  if (projectId <= 0) return { verdict: 'reject', message: '错误上报 DSN 的项目 ID 必须是正整数' };
  const h = host.toLowerCase();
  if (
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    h === 'metadata' ||
    h === 'metadata.google.internal' ||
    /^127\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^\[?fe80:/i.test(h)
  ) {
    return {
      verdict: 'reject',
      message: '错误上报 DSN 不能指向本机或云元数据地址(localhost/127.0.0.1/::1):客户端会把事件发往自己的电脑,永远收不到',
    };
  }
  const prefix = segments.slice(0, -1).join('/');
  const storeEndpoint = `${scheme}://${host}${port ? ':' + port : ''}/${prefix ? prefix + '/' : ''}api/${projectId}/store/`;
  const warnings: string[] = [];
  if (scheme === 'http') warnings.push('使用 http:// 明文传输错误上报数据,存在泄露风险');
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) {
    warnings.push('该地址属于内网私有网段,客户端在内网之外将无法上报');
  }
  return { verdict: warnings.length ? 'warn' : 'accept', message: warnings.join(';'), storeEndpoint, publicKey };
}

function classifyFetchError(e: unknown): string {
  const err = e as { name?: string; message?: string; code?: string };
  const msg = `${err?.name ?? ''} ${err?.message ?? ''}`.toLowerCase();
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'TIMEOUT';
  if (/no such host|enotfound|dns/.test(msg)) return 'DNS';
  if (/tls|x509|certificate|ssl/.test(msg)) return 'TLS';
  if (/connection refused|network is unreachable|no route to host|connection reset|connect:|econnreset|econnrefused/.test(msg)) return 'CONNECT';
  if (/canceled|cancelled/.test(msg)) return 'CANCELED';
  return 'UNKNOWN';
}
