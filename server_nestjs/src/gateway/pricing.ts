/**
 * 网关计费与 token 估算纯函数（无 DI，供 GatewayService 复用）。
 * 口径与 Go server/internal/serverstore/usage.go 的 costOfAt 逐字段对齐。
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
/** 每 token 估算字节数（Go estimatedBytesPerToken=4）。 */
const ESTIMATED_BYTES_PER_TOKEN = 4;
export const MAX_ESTIMATED_COMPLETION_TOKENS = 65536;
export const MAX_ESTIMATED_PROMPT_TOKENS = 131072;

export interface PeakWindow {
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  weekdays?: number[]; // 1=周一..7=周日；缺省=每天
}

/** 解析 usage.peak_windows（JSON 数组）；非法/空回 []。 */
export function parsePeakWindows(raw: string | null): PeakWindow[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: PeakWindow[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const start = typeof item.start === 'string' ? item.start : '';
      const end = typeof item.end === 'string' ? item.end : '';
      if (!start || !end) continue;
      const weekdays = Array.isArray(item.weekdays)
        ? item.weekdays.filter((d: unknown) => typeof d === 'number')
        : undefined;
      out.push({ start, end, weekdays });
    }
    return out;
  } catch {
    return [];
  }
}

/** "HH:MM" → 分钟数（0..1439）；非法回 null。 */
function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 某时刻（北京口径）是否落在任一峰谷窗口内。 */
export function inPeakWindow(now: Date, windows: PeakWindow[]): boolean {
  if (!windows || windows.length === 0) return false;
  const beijing = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  // Beijing weekday：Mon=1..Sun=7（getUTCDay 0=Sun..6=Sat）。
  const weekday = ((beijing.getUTCDay() + 6) % 7) + 1;
  for (const w of windows) {
    const start = hhmmToMinutes(w.start);
    const end = hhmmToMinutes(w.end);
    if (start === null || end === null) continue;
    let inTime: boolean;
    if (start <= end) {
      inTime = minutes >= start && minutes < end;
    } else {
      // 跨午夜窗口：如 22:00~06:00。
      inTime = minutes >= start || minutes < end;
    }
    const inDay =
      !w.weekdays || w.weekdays.length === 0 || w.weekdays.includes(weekday);
    if (inTime && inDay) return true;
  }
  return false;
}

/** 峰谷折扣因子：峰内=1；峰外=offpeak（仅当 0<offpeak<1 且存在窗口）。 */
export function offpeakFactor(
  now: Date,
  offpeak: number | null | undefined,
  windows: PeakWindow[],
): number {
  const discount = offpeak ?? 0;
  if (!(discount > 0 && discount < 1) || windows.length === 0) return 1;
  if (inPeakWindow(now, windows)) return 1;
  return discount;
}

/** clamp 非负（负数→0）。 */
export function clampNonNeg(n: number): number {
  return n < 0 ? 0 : n;
}

/**
 * 单次调用费用（元）。
 * cost = miss_input×input/1e6 + cache×cachePrice/1e6 + output×output/1e6，
 * 峰外再 ×offpeak。cachePrice 回退 input。
 */
export function costOfAt(
  now: Date,
  promptTokens: number,
  completionTokens: number,
  cacheTokens: number,
  inputPer1M: number,
  outputPer1M: number,
  cacheInputPer1M: number,
  offpeak: number | null | undefined,
  windows: PeakWindow[],
): number {
  const pt = clampNonNeg(promptTokens);
  const ct = clampNonNeg(completionTokens);
  const cache = clampNonNeg(cacheTokens);
  const cachePrice = cacheInputPer1M > 0 ? cacheInputPer1M : inputPer1M;
  const missTokens = Math.max(pt - cache, 0);
  const base =
    (missTokens / 1e6) * inputPer1M +
    (cache / 1e6) * cachePrice +
    (ct / 1e6) * outputPer1M;
  return base * offpeakFactor(now, offpeak, windows);
}

/** web_search 按次费用（元，无峰谷折扣）。 */
export function searchFee(searchRequests: number, searchPer1K: number): number {
  const n = clampNonNeg(searchRequests);
  if (n <= 0 || searchPer1K <= 0) return 0;
  return (n / 1000) * searchPer1K;
}

/** 按字节估算 token（n/4，0 字节→0）。 */
export function estimateTokensFromBytes(bytes: number): number {
  const n = clampNonNeg(bytes);
  if (n <= 0) return 0;
  return Math.floor(n / ESTIMATED_BYTES_PER_TOKEN);
}

/** 由请求体字节数估算输入 token（简化：不做内联二进制剥离）。 */
export function estimatePromptTokensFromBytes(bytes: number): number {
  const tokens = estimateTokensFromBytes(bytes);
  return Math.min(tokens, MAX_ESTIMATED_PROMPT_TOKENS);
}

/** 由 embedding 输入估算 token：Σ 字节/4，0 字节→0，否则至少 1。 */
export function estimateEmbeddingPromptTokens(inputs: string[]): number {
  let bytes = 0;
  for (const s of inputs) bytes += Buffer.byteLength(s, 'utf8');
  if (bytes <= 0) return 0;
  const n = estimateTokensFromBytes(bytes);
  return n > 0 ? n : 1;
}

/**
 * 补全 token 估算：completion>0 用真实值；否则按下发字节/4（≥1，封顶 65536）。
 */
export function estimateCompletionTokens(
  completion: number,
  deliveredBytes: number,
): { tokens: number; estimated: boolean } {
  if (completion > 0) return { tokens: completion, estimated: false };
  let est = estimateTokensFromBytes(deliveredBytes);
  if (est <= 0) est = deliveredBytes <= 0 ? 0 : 1;
  if (est > MAX_ESTIMATED_COMPLETION_TOKENS) est = MAX_ESTIMATED_COMPLETION_TOKENS;
  return { tokens: est, estimated: true };
}

/** 元 → 微元整数（1e6 缩放；NaN/Inf→0）。 */
export function moneyToMicro(v: number): number {
  if (Number.isNaN(v) || !Number.isFinite(v)) return 0;
  return Math.round(v * 1e6);
}

/** 微元 → 元。 */
export function microToMoney(m: number): number {
  return m / 1e6;
}
