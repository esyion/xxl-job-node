import { AsyncLocalStorage } from 'node:async_hooks';
import { formatDateTime } from '../util/misc.js';
import { CODE_FAIL, CODE_NO_CHANGE, CODE_SUCCESS, CODE_TIMEOUT } from '../protocol/dto.js';
import { fileAppender } from '../log/FileAppender.js';

/**
 * 任务执行上下文。通过 AsyncLocalStorage 跨 await 自动传播，
 * 等价于 Java 版的 InheritableThreadLocal<XxlJobContext>。
 */
export interface XxlJobContext {
  jobId: number;
  logId: number;
  logDateTime: number;
  executorParams: string;
  logFileName: string;
  shardIndex: number;
  shardTotal: number;
  /** 0=运行中 200=成功 500=失败 502=超时 */
  handleCode: number;
  handleMsg: string;
  /** kill/COVER_EARLY/超时时的协作式取消信号 */
  abortSignal: AbortSignal;
}

const storage = new AsyncLocalStorage<XxlJobContext>();

export const XxlJobContextStorage = {
  run<T>(ctx: XxlJobContext, fn: () => Promise<T>): Promise<T> {
    return storage.run(ctx, fn);
  },
  get(): XxlJobContext | undefined {
    return storage.getStore();
  },
};

/**
 * 面向任务开发者的静态 API，等价 Java 版 XxlJobHelper。
 * 仅可在任务 handler 执行链路内调用（AsyncLocalStorage 取当前上下文）。
 */
export class XxlJobHelper {
  static requireCtx(): XxlJobContext {
    const ctx = storage.getStore();
    if (!ctx) throw new Error('XxlJobHelper called outside of job context');
    return ctx;
  }

  /** 写一行任务日志，带时间戳与调用点 */
  static async log(message: unknown): Promise<void> {
    const ctx = this.requireCtx();
    let line: string;
    if (message instanceof Error) {
      line = `${formatDateTime(new Date())} ${message.stack ?? String(message)}`;
    } else {
      const err = new Error();
      Error.captureStackTrace?.(err, this.log);
      const caller = err.stack?.split('\n')[1]?.trim().replace(/^at\s+/, '') ?? '';
      const msg = typeof message === 'string' ? message : JSON.stringify(message);
      line = `${formatDateTime(new Date())} [${caller}]: ${msg}`;
    }
    await fileAppender.appendLog(ctx.logFileName, line);
  }

  static getJobParam(): string {
    return this.requireCtx().executorParams;
  }

  static getLogId(): number {
    return this.requireCtx().logId;
  }

  static getJobId(): number {
    return this.requireCtx().jobId;
  }

  static getShardIndex(): number {
    return this.requireCtx().shardIndex;
  }

  static getShardTotal(): number {
    return this.requireCtx().shardTotal;
  }

  static getAbortSignal(): AbortSignal {
    return this.requireCtx().abortSignal;
  }

  static handleSuccess(msg = 'success'): void {
    const ctx = this.requireCtx();
    if (ctx.handleCode !== CODE_NO_CHANGE) return;
    ctx.handleCode = CODE_SUCCESS;
    ctx.handleMsg = msg;
  }

  static handleFail(msg: string): void {
    const ctx = this.requireCtx();
    if (ctx.handleCode === CODE_SUCCESS) return;
    ctx.handleCode = CODE_FAIL;
    ctx.handleMsg = appendMsg(ctx.handleMsg, msg);
  }

  static handleTimeout(msg: string): void {
    const ctx = this.requireCtx();
    ctx.handleCode = CODE_TIMEOUT;
    ctx.handleMsg = appendMsg(ctx.handleMsg, msg);
  }
}

function appendMsg(base: string, msg: string): string {
  return base ? `${base}\n${msg}` : msg;
}

export { CODE_NO_CHANGE, CODE_SUCCESS, CODE_FAIL, CODE_TIMEOUT };
