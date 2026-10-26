/**
 * 北京时区（固定 UTC+8）时间工具 —— 与 Go server 口径一致，不依赖进程 TZ。
 * Go 侧所有「日/月」窗口都按北京日历计算（now() + interval '8 hours'），
 * 这里用固定偏移复刻，避免部署机时区差异导致账期漂移。
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface BeijingParts {
  year: number;
  /** 0-based 月（0=1 月）。 */
  month: number;
  /** 1-based 日。 */
  day: number;
}

/** 把某时刻拆成北京日历的 year/month/day。 */
export function beijingParts(d: Date = new Date()): BeijingParts {
  const t = new Date(d.getTime() + BEIJING_OFFSET_MS);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth(), day: t.getUTCDate() };
}

/** UTC 时刻 = 北京某日 00:00（即前一日 16:00 UTC）。 */
export function beijingDayStartUTC(
  year: number,
  month: number,
  day: number,
): Date {
  return new Date(Date.UTC(year, month, day) - BEIJING_OFFSET_MS);
}

/** UTC 时刻 = 北京某月 1 日 00:00。 */
export function beijingMonthStartUTC(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1) - BEIJING_OFFSET_MS);
}

/** 北京日期字符串 YYYY-MM-DD（供 usage_daily.day 等 date 列）。 */
export function beijingDayStr(d: Date = new Date()): string {
  const p = beijingParts(d);
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 北京月初字符串 YYYY-MM-01（供 usage_monthly.month）。 */
export function beijingMonthStartStr(d: Date = new Date()): string {
  const p = beijingParts(d);
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-01`;
}

/** 北京月键 YYYYMM（供 balance_grant_items.month / balance_grants.month）。 */
export function beijingMonthKey(d: Date = new Date()): string {
  const p = beijingParts(d);
  return `${p.year}${String(p.month + 1).padStart(2, '0')}`;
}

/** RFC3339（秒精度，UTC）—— 与 Go time.RFC3339 口径一致（审计哈希链用）。 */
export function rfc3339UTC(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
