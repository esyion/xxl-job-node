import { Worker } from 'node:worker_threads';
import { runAsWorker, type WorkerJobContext, type WorkerOutMessage, type WorkerRunMessage } from './runAsWorker.js';
import { fileAppender } from '../log/FileAppender.js';
import { formatDateTime } from '../util/misc.js';
import { CODE_FAIL, CODE_SUCCESS, CODE_TIMEOUT } from '../protocol/dto.js';

export interface WorkerRunResult {
  handleCode: number;
  handleMsg: string;
}

interface WorkerSlot {
  worker: Worker;
  /** 当前正在执行的任务（日志归属） */
  current: {
    logId: number;
    logFileName: string;
  } | null;
  /** 当前 run() 的完成回调（terminate 时用于立即返回失败） */
  pending: {
    resolve: (r: WorkerRunResult) => void;
    terminateReason: string | null;
  } | null;
}

/**
 * CPU 密集任务的 worker 线程池：
 *  - 每 jobId 复用一个 worker（串行队列保证同一任务同时只有一个执行）
 *  - 超时 / kill / COVER_EARLY 通过 worker.terminate() 真正终止（比 Java 版 interrupt 更强）
 *  - worker 内 console.log/warn/error 自动写入任务日志文件
 */
export class WorkerPool {
  private slots = new Map<number, WorkerSlot>();

  /**
   * 在 jobId 对应的 worker 中执行任务。
   * @param signal kill/COVER_EARLY 的协作取消信号，abort 时 terminate worker
   * @param timeoutSec 超时秒数，0 = 不限时；超时 terminate 并返回 502
   */
  async run(
    jobId: number,
    workerFile: string,
    ctx: WorkerJobContext,
    logFileName: string,
    signal: AbortSignal,
    timeoutSec: number,
  ): Promise<WorkerRunResult> {
    const slot = await this.ensureWorker(jobId, workerFile);

    return new Promise<WorkerRunResult>((resolve) => {
      slot.current = { logId: ctx.logId, logFileName };
      slot.pending = { resolve, terminateReason: null };

      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: WorkerRunResult) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        slot.current = null;
        slot.pending = null;
        resolve(result);
      };

      const onAbort = () => {
        // kill / COVER_EARLY：真终止
        if (slot.pending) slot.pending.terminateReason = 'job killed';
        this.terminate(jobId);
        settle({ handleCode: CODE_FAIL, handleMsg: 'job running, killed by worker terminate' });
      };
      signal.addEventListener('abort', onAbort, { once: true });

      if (timeoutSec > 0) {
        timer = setTimeout(() => {
          if (slot.pending) slot.pending.terminateReason = 'timeout';
          this.terminate(jobId);
          settle({ handleCode: CODE_TIMEOUT, handleMsg: `job execute timeout (${timeoutSec}s), worker terminated` });
        }, timeoutSec * 1000);
      }

      const messageHandler = (msg: WorkerOutMessage) => {
        if (msg.type === 'log') {
          const level = msg.level === 'log' ? '' : `[${msg.level.toUpperCase()}] `;
          void fileAppender
            .appendLog(logFileName, `${formatDateTime(new Date())} ${level}${msg.text}`)
            .catch(() => undefined);
          return;
        }
        slot.worker.off('message', messageHandler);
        if (msg.type === 'done') {
          settle({ handleCode: CODE_SUCCESS, handleMsg: 'success' });
        } else {
          settle({ handleCode: CODE_FAIL, handleMsg: msg.error });
        }
      };
      slot.worker.on('message', messageHandler);

      const runMsg: WorkerRunMessage = {
        type: 'run',
        ctx: { jobId, logId: ctx.logId, executorParams: ctx.executorParams, shardIndex: ctx.shardIndex, shardTotal: ctx.shardTotal },
      };
      slot.worker.postMessage(runMsg);
    });
  }

  /** 终止 jobId 的 worker（下次 run 自动重建）。幂等。 */
  terminate(jobId: number, _reason?: string): void {
    const slot = this.slots.get(jobId);
    if (!slot) return;
    this.slots.delete(jobId);
    slot.current = null;
    slot.pending = null;
    slot.worker.removeAllListeners();
    void slot.worker.terminate().catch(() => undefined);
  }

  terminateAll(): void {
    for (const jobId of [...this.slots.keys()]) {
      this.terminate(jobId);
    }
  }

  private async ensureWorker(jobId: number, workerFile: string): Promise<WorkerSlot> {
    const existing = this.slots.get(jobId);
    if (existing) return existing;

    const execArgv = workerFile.endsWith('.ts') ? ['--import', 'tsx'] : [];
    const worker = new Worker(workerFile, {
      execArgv,
      stdout: true,
      stderr: true,
    });
    const slot: WorkerSlot = { worker, current: null, pending: null };
    this.slots.set(jobId, slot);

    worker.on('error', (err) => {
      const pending = slot.pending;
      this.terminate(jobId, 'worker error');
      if (pending) {
        pending.resolve({ handleCode: CODE_FAIL, handleMsg: `worker crashed: ${err.message}` });
      }
    });
    worker.on('exit', (code) => {
      // 非 terminate 引起的退出（如用户 process.exit）
      if (this.slots.get(jobId) === slot && slot.pending) {
        const pending = slot.pending;
        this.slots.delete(jobId);
        pending.resolve({
          handleCode: CODE_FAIL,
          handleMsg: `worker exited unexpectedly (code=${code})`,
        });
      }
    });
    // worker 的 stdout/stderr 兜底转发（console 之外的直接输出）
    worker.stdout?.on('data', (chunk: Buffer) => {
      if (slot.current) {
        void fileAppender.appendLog(slot.current.logFileName, chunk.toString('utf8')).catch(() => undefined);
      }
    });
    worker.stderr?.on('data', (chunk: Buffer) => {
      if (slot.current) {
        void fileAppender.appendLog(slot.current.logFileName, `[STDERR] ${chunk.toString('utf8')}`).catch(() => undefined);
      }
    });

    return slot;
  }
}

export { runAsWorker };
