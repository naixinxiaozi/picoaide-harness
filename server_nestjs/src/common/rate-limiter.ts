/**
 * 滑动窗口限流器（与 Go telemetry.callLimiter 对齐）：
 * 按 key 记录命中时间戳，窗口内计数 >= limit 即拒绝；limit<=0 表示不限流。
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private lastSweep = 0;

  constructor(windowMs = 60_000, maxKeys = 10_000) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  allow(key: string, limit: number): boolean {
    if (limit <= 0) return true;
    const now = Date.now();
    if (now - this.lastSweep >= 60_000) {
      this.sweep(now);
      this.lastSweep = now;
    }
    const cutoff = now - this.windowMs;
    let arr = this.hits.get(key) ?? [];
    const kept: number[] = [];
    for (const t of arr) if (t > cutoff) kept.push(t);
    arr = kept;
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return false;
    }
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      this.evictOldest();
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of this.hits) {
      if (v.length && v[0] < oldest) {
        oldest = v[0];
        oldestKey = k;
      }
    }
    if (oldestKey) this.hits.delete(oldestKey);
  }

  private sweep(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [k, arr] of this.hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) this.hits.set(k, kept);
      else this.hits.delete(k);
    }
  }
}
