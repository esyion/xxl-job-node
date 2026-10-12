import { isMainThread, parentPort } from 'node:worker_threads';

/** worker 内任务上下文（与主线程 TriggerRequest 的关键字段对齐） */
export interface WorkerJobContext {
  jobId: number;
  logId: number;
  executorParams: string;
  shardIndex: number;
  shardTotal: number;
}

export interface WorkerRunMessage {
  type: 'run';
  ctx: WorkerJobContext;
}

export type WorkerOutMessage =
  | { type: 'log'; level: 'log' | 'warn' | 'error'; text: string }
  | { type: 'done' }
  | { type: 'fail'; error: string };

/**
 * worker 文件入口。用户 worker 文件（.ts/.js）导入并调用：
 *
 *   import { runAsWorker } from '@xxl-job-node/core';
 *   runAsWorker(async (ctx) => {
 *     console.log('参数：', ctx.executorParams);  // 自动写入任务日志
 *     // CPU 密集逻辑；抛错 = 失败，正常返回 = 成功
 *   });
 *
 * 在主线程导入同一文件时是 no-op，因此注册入口与 worker 实现可放同一个文件。
 */
export function runAsWorker(fn: (ctx: WorkerJobContext) => Promise<void> | void): void {
  if (isMainThread || !parentPort) return;
  const port = parentPort;

  // console 输出转发到任务日志文件（主线程落盘）
  const forward =
    (level: 'log' | 'warn' | 'error') =>
    (...args: unknown[]) => {
      port.postMessage({
        type: 'log',
        level,
        text: args
          .map((a) => (a instanceof Error ? (a.stack ?? String(a)) : typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' '),
      } satisfies WorkerOutMessage);
    };
  console.log = forward('log');
  console.warn = forward('warn');
  console.error = forward('error');

  port.on('message', (msg: WorkerRunMessage) => {
    if (msg?.type !== 'run') return;
    void (async () => {
      try {
        await fn(msg.ctx);
        port.postMessage({ type: 'done' } satisfies WorkerOutMessage);
      } catch (e) {
        port.postMessage({ type: 'fail', error: e instanceof Error ? (e.stack ?? String(e)) : String(e) } satisfies WorkerOutMessage);
      }
    })();
  });
}
