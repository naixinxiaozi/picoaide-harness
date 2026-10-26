/**
 * 金额口径（与现有 server 的 balance.go 对齐）。
 * 三层精度：roundMoney(分) / QuantizeMoney(对外展示与闸门判定,分位四舍五入) /
 * roundMicro(账本精度,微元 1e-6)。
 */

const MONEY_MICRO_SCALE = 1_000_000;

/** 金额取整到分（对外展示、发放额度、手工调整的输入口径）。 */
export function roundMoney(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 对外输出/闸门判定的金额口径：分位四舍五入。
 * 所有返回给客户端与管理端的 balance_money 都必须经它，保证
 * 「展示值 == 判定值 == 客户端告警阈值」三处同源。
 */
export function quantizeMoney(v: number): number {
  if (Number.isNaN(v) || !Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

/** 账本精度（微元,1e-6）：单次调用费用常为几厘钱，按分取整会抹零。 */
export function roundMicro(v: number): number {
  return Math.round(v * MONEY_MICRO_SCALE) / MONEY_MICRO_SCALE;
}

/** 格式化金额为固定两位小数字符串。 */
export function formatMoney(v: number): string {
  return quantizeMoney(v).toFixed(2);
}
