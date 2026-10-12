import { PRE_READ_MS } from '@xxl-job-node/core';
import { config } from '../config.js';
import { withTransaction } from '../db/pool.js';
import { jobInfoDao, lockDao, type ScheduleUpdate } from '../dao/index.js';
import type { XxlJobInfo } from '../db/entities.js';
import { generateNextTriggerTime } from './ScheduleType.js';
import { TriggerPool } from './TriggerPool.js';
import { trigger, TriggerTypeEnum } from './JobTrigger.js';

const SECOND_MS = 1000;
/** misfire 判定阈值：过期超 5 秒 */
const MISFIRE_THRESHOLD_MS = 5000;

/**
 * 调度内核（对齐 Java 版 JobScheduleHelper）：
 *
 * scheduleThread：每秒一轮，事务内 FOR UPDATE 行锁 → 预读未来 5s 内到期任务 →
 *                三分支（misfire 补偿 / 立即触发 / 推入时间轮）→ 批量回写游标 → commit 释放锁。
 * ringThread：   60 槽内存时间轮，每秒取刻度时回看 3 槽容错。
 *
 * 多 admin 集群时同一秒只有一个实例持有行锁做扫描，保证不重复触发。
 */
export class ScheduleCore {
  readonly triggerPool = new TriggerPool();
  private ring: Array<Set<number>> = Array.from({ length: 60 }, () => new Set<number>());
  private stopped = false;
  private ringEmptyRound = 0;

  start(): void {
    void this.scheduleLoop();
    void this.ringLoop();
    console.log('[xxl-job-admin] schedule core started.');
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  // ==================== scheduleThread ====================

  private async scheduleLoop(): Promise<void> {
    while (!this.stopped) {
      const startMs = Date.now();
      try {
        await this.scheduleOnce();
      } catch (e) {
        console.error('[schedule] scan error:', e instanceof Error ? e.message : e);
      }
      // 秒边界对齐：处理快等满 1s；空转轮询可稍长
      const costMs = Date.now() - startMs;
      const waitMs = this.ringEmptyRound > 3 ? 5 * SECOND_MS : SECOND_MS;
      const nextBoundary = Math.ceil((Date.now() + 1) / SECOND_MS) * SECOND_MS;
      await sleepFixed(Math.max(nextBoundary - Date.now(), Math.min(waitMs - costMs, waitMs)));
    }
  }

  private async scheduleOnce(): Promise<void> {
    const nowMs = Date.now();
    const updates: ScheduleUpdate[] = [];

    await withTransaction(async (conn) => {
      // 集群互斥行锁：持锁期 = 扫描 + 计算 + 回写
      await lockDao.scheduleLock(conn);

      const jobs = await jobInfoDao.scheduleQuery(conn, nowMs + PRE_READ_MS, config.trigger.preReadCount);

      for (const job of jobs) {
        const nowTime = Date.now();

        if (nowTime > job.trigger_next_time + MISFIRE_THRESHOLD_MS) {
          // ① 已过期超 5s：misfire 补偿策略，再从当前时间重算
          await this.handleMisfire(job);
          const next = refreshNextValidTime(job, new Date());
          updates.push(buildUpdate(job, job.trigger_next_time, next));
        } else if (nowTime >= job.trigger_next_time) {
          // ② 5 秒窗口内到期：立即触发
          this.triggerPool.submit(job.id, () =>
            trigger(job.id, { triggerType: TriggerTypeEnum.CRON }).catch((e) =>
              console.error(`[schedule] trigger job ${job.id} error:`, e),
            ),
          );
          const next = refreshNextValidTime(job, new Date(job.trigger_next_time));
          // 新的下次触发若仍在预读窗口内 → 顺便推入时间轮
          const nextTime = next ?? 0;
          if (nextTime > 0 && nextTime <= Date.now() + PRE_READ_MS) {
            this.pushRing(nextTime, job.id);
          }
          updates.push(buildUpdate(job, job.trigger_next_time, next));
        } else {
          // ③ 纯未来（5s 内）：推入时间轮对应秒槽，以旧 next 为基准刷新
          this.pushRing(job.trigger_next_time, job.id);
          const next = refreshNextValidTime(job, new Date(job.trigger_next_time));
          updates.push(buildUpdate(job, job.trigger_last_time, next));
        }
      }

      if (updates.length > 0) {
        await jobInfoDao.scheduleBatchUpdate(conn, updates);
      }
    });
  }

  private async handleMisfire(job: XxlJobInfo): Promise<void> {
    if (job.misfire_strategy === 'FIRE_ONCE_NOW') {
      this.triggerPool.submit(job.id, () =>
        trigger(job.id, { triggerType: TriggerTypeEnum.MISFIRE }).catch(() => undefined),
      );
    } else {
      console.warn(`[schedule] job ${job.id} misfire, strategy=DO_NOTHING, skip.`);
    }
  }

  private pushRing(nextTimeMs: number, jobId: number): void {
    const ringSecond = Math.floor(nextTimeMs / SECOND_MS) % 60;
    this.ring[ringSecond]?.add(jobId);
  }

  // ==================== ringThread ====================

  private async ringLoop(): Promise<void> {
    while (!this.stopped) {
      // 秒边界对齐
      const nextBoundary = Math.ceil((Date.now() + 1) / SECOND_MS) * SECOND_MS;
      await sleepFixed(nextBoundary - Date.now());

      const nowSecond = Math.floor(Date.now() / SECOND_MS) % 60;
      // 回看 3 个刻度：容忍上一轮处理耗时跨刻度导致漏调度
      let fired = 0;
      for (let i = 0; i < 3; i++) {
        const idx = (nowSecond + 60 - i) % 60;
        const slot = this.ring[idx];
        if (!slot || slot.size === 0) continue;
        this.ring[idx] = new Set();
        for (const jobId of slot) {
          fired++;
          this.triggerPool.submit(jobId, () =>
            trigger(jobId, { triggerType: TriggerTypeEnum.CRON }).catch((e) =>
              console.error(`[ring] trigger job ${jobId} error:`, e),
            ),
          );
        }
      }
      this.ringEmptyRound = fired > 0 ? 0 : this.ringEmptyRound + 1;
    }
  }
}

/** 计算并刷新 next；失败则停任务（对齐 Java：调度配置异常自动 STOPPED） */
function refreshNextValidTime(job: XxlJobInfo, fromTime: Date): number | null {
  const next = generateNextTriggerTime(job, fromTime);
  return next;
}

function buildUpdate(job: XxlJobInfo, lastTime: number, next: number | null): ScheduleUpdate {
  if (next === null || next <= 0) {
    // 下次时间计算失败 → 置为停止（trigger_status=0 且游标清零）
    return { id: job.id, trigger_last_time: 0, trigger_next_time: 0, trigger_status: 0 };
  }
  // trigger_status 传原值维持不变（batch SQL 的 WHERE 条件仍是 1）
  return { id: job.id, trigger_last_time: lastTime, trigger_next_time: next, trigger_status: job.trigger_status };
}

function sleepFixed(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}
