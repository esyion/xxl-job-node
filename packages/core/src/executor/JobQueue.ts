import { CODE_FAIL, CODE_SUCCESS } from '../protocol/dto.js';
import type { CallbackData, Response, TriggerRequest } from '../protocol/dto.js';

/**
 * 每 jobId 一个串行队列，等价 Java 版 JobThread + LinkedBlockingQueue：
 *  - 同一任务同一时刻只有一个 handler 在执行，队列缓冲后续触发
 *  - logIdSet 防止 admin 重复调度同一日志
 *  - 阻塞策略：SERIAL_EXECUTION / DISCARD_LATER / COVER_EARLY
 *  - kill：终止当前 + 队列内未执行的逐个回调失败
 */
export class JobQueue {
  readonly jobId: number;
  private queue: TriggerRequest[] = [];
  private logIdSet = new Set<number>();
  private running = false;
  /** 当前执行被中断的原因（COVER_EARLY soft-kill 只影响当前这一次） */
  private stopReason: string | null = null;
  /** 永久停止（admin kill / executor destroy），当前项结束后队列销毁 */
  private permanentKilled = false;
  private controller: AbortController | null = null;
  private idleSince = Date.now();

  constructor(
    jobId: number,
    private executeOne: (req: TriggerRequest, controller: AbortController) => Promise<CallbackData>,
    private onCallback: (data: CallbackData) => void,
  ) {
    this.jobId = jobId;
  }

  isRunningOrHasQueue(): boolean {
    return this.running || this.queue.length > 0;
  }

  isIdle(): boolean {
    return !this.running && this.queue.length === 0;
  }

  getIdleMs(): number {
    return Date.now() - this.idleSince;
  }

  /** 入队一个触发请求，处理阻塞策略 */
  push(req: TriggerRequest): Response<string> {
    if (this.logIdSet.has(req.logId)) {
      return { code: CODE_FAIL, msg: `repeat trigger job, logId:${req.logId}` };
    }
    const busy = this.isRunningOrHasQueue();
    if (busy && req.executorBlockStrategy === 'DISCARD_LATER') {
      return { code: CODE_FAIL, msg: 'block strategy effect: discard later' };
    }
    if (busy && req.executorBlockStrategy === 'COVER_EARLY') {
      this.softKill('block strategy effect: cover early');
    }
    this.logIdSet.add(req.logId);
    this.queue.push(req);
    if (!this.running) {
      this.running = true;
      void this.drain();
    }
    return { code: CODE_SUCCESS, msg: 'trigger success, JobQueue push' };
  }

  /** 永久终止：中断当前 + 队列剩余全部回调失败（admin kill / 优雅停机） */
  kill(reason: string): void {
    this.stopReason ??= reason;
    this.permanentKilled = true;
    this.controller?.abort();
    this.drainQueueAsFail(`${reason} [job not executed, in the job queue, killed.]`);
  }

  /** 软终止：仅中断当前执行，队列继续接纳新请求（COVER_EARLY） */
  private softKill(reason: string): void {
    this.stopReason = reason;
    this.controller?.abort();
    this.drainQueueAsFail(`${reason} [job not executed, in the job queue, killed.]`);
  }

  private drainQueueAsFail(msg: string): void {
    while (this.queue.length > 0) {
      const req = this.queue.shift();
      if (!req) break;
      this.logIdSet.delete(req.logId);
      this.onCallback({
        logId: req.logId,
        logDateTime: req.logDateTime,
        handleCode: CODE_FAIL,
        handleMsg: msg,
      });
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.permanentKilled) {
      const req = this.queue.shift();
      if (!req) break;
      this.logIdSet.delete(req.logId);
      const controller = new AbortController();
      this.controller = controller;
      const cb = await this.executeOne(req, controller);
      if (this.stopReason) {
        cb.handleCode = CODE_FAIL;
        cb.handleMsg = `${this.stopReason} [job running, killed]\n${cb.handleMsg}`;
        this.stopReason = null;
      }
      this.onCallback(cb);
    }
    this.running = false;
    this.controller = null;
    this.idleSince = Date.now();
  }
}
