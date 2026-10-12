import { config } from '../config.js';

/**
 * 简易并发限制器（语义对齐线程池的最大并发）。
 */
export function createLimiter(concurrency: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

interface JobRateStat {
  minute: number;
  /** 本分钟内慢触发（>500ms）次数 */
  slowCount: number;
}

/**
 * 触发线程池：fast/slow 双池隔离。
 * 单任务 1 分钟内触发耗时 >500ms 达 10 次 → 降级 slow 池，防止慢执行器拖垮整体。
 */
export class TriggerPool {
  private readonly fast: (fn: () => Promise<void>) => Promise<void>;
  private readonly slow: (fn: () => Promise<void>) => Promise<void>;
  private readonly rateStats = new Map<number, JobRateStat>();

  constructor() {
    this.fast = createLimiter(config.trigger.fastMax);
    this.slow = createLimiter(config.trigger.slowMax);
  }

  /** 提交一个异步触发任务（不等待） */
  submit(jobId: number, fn: () => Promise<void>): void {
    const pool = this.pickPool(jobId);
    void pool(async () => {
      const start = Date.now();
      try {
        await fn();
      } catch (e) {
        console.error(`[trigger] job ${jobId} error:`, e);
      } finally {
        this.record(jobId, Date.now() - start);
      }
    });
  }

  private pickPool(jobId: number): (fn: () => Promise<void>) => Promise<void> {
    const stat = this.rateStats.get(jobId);
    if (!stat) return this.fast;
    const currentMinute = Math.floor(Date.now() / 60_000);
    if (stat.minute === currentMinute && stat.slowCount >= 10) return this.slow;
    return this.fast;
  }

  private record(jobId: number, costMs: number): void {
    const currentMinute = Math.floor(Date.now() / 60_000);
    const stat = this.rateStats.get(jobId);
    if (!stat || stat.minute !== currentMinute) {
      this.rateStats.set(jobId, { minute: currentMinute, slowCount: costMs > 500 ? 1 : 0 });
      return;
    }
    if (costMs > 500) stat.slowCount++;
  }
}
