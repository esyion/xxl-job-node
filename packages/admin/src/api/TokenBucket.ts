/**
 * 令牌桶限流（对齐 Java 版 OpenApiController：100 token / 30s，超限拒绝）。
 * 语义：每 30 秒恢复满容量，期间每次调用消耗 1 个。
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillIntervalMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  tryAcquire(): boolean {
    const now = Date.now();
    if (now - this.lastRefillAt >= this.refillIntervalMs) {
      this.tokens = this.capacity;
      this.lastRefillAt = now;
    }
    if (this.tokens <= 0) return false;
    this.tokens--;
    return true;
  }
}
