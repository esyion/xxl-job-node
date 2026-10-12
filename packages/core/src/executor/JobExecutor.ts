import fs from 'node:fs';
import path from 'node:path';
import { CODE_FAIL, CODE_SUCCESS, GLUE_TYPES } from '../protocol/dto.js';
import type {
  CallbackData,
  LogData,
  Response,
  TriggerRequest,
} from '../protocol/dto.js';
import { fileAppender } from '../log/FileAppender.js';
import { XxlJobContextStorage, XxlJobHelper } from '../context/XxlJobContext.js';
import type { XxlJobContext } from '../context/XxlJobContext.js';
import { JobQueue } from './JobQueue.js';
import { getJobMethodMeta, isScriptGlue } from '../handler/JobHandler.js';
import type { JobHandler } from '../handler/JobHandler.js';
import { EmbedServer, getLocalIp } from '../server/EmbedServer.js';
import { CallbackThread, RegistryThread } from '../thread/ExecutorThreads.js';
import { execToFile } from '../util/script.js';
import { sleep } from '../util/misc.js';
import { WorkerPool } from '../worker/WorkerPool.js';

export interface XxlJobExecutorConfig {
  /** 调度中心地址，逗号分隔，如 http://127.0.0.1:8989,http://127.0.0.1:8990 */
  adminAddresses: string;
  appname: string;
  accessToken: string;
  ip?: string;
  /** 缺省从 9999 起自动探测可用端口 */
  port?: number;
  /** 完整地址覆盖，如 http://192.168.1.10:9999/（多网卡/Docker 场景） */
  address?: string;
  /** 日志根目录，默认 {cwd}/logs/xxl-job/jobhandler */
  logPath?: string;
  /** 日志保留天数，默认 30，<3 视为关闭 */
  logRetentionDays?: number;
  /** 与 admin 通信超时（秒），默认 3 */
  timeout?: number;
}

/** 等待运行中任务的优雅停机窗口（秒） */
const ELEGANT_SHUTDOWN_WAITING_SECONDS = 5;
/** 空闲队列回收阈值（毫秒） */
const IDLE_QUEUE_RECYCLE_MS = 90_000;

/**
 * 执行器主类：等价 Java 版 XxlJobExecutor。
 * 一个进程一个实例，职责：handler 仓库、任务队列仓库、内嵌服务器、注册/回调/清理线程。
 */
export class JobExecutor {
  private static instance: JobExecutor | null = null;

  static getInstance(): JobExecutor | null {
    return JobExecutor.instance;
  }

  readonly adminAddresses: string[];
  private readonly appname: string;
  private readonly accessToken: string;
  private readonly logPath: string;
  private readonly logRetentionDays: number;
  private readonly timeoutSec: number;
  private readonly configIp?: string;
  private readonly configPort?: number;
  private readonly configAddress?: string;

  private started = false;
  private address = '';
  private jobHandlerRepository = new Map<string, JobHandler>();
  private workerHandlerRepository = new Map<string, string>();
  private jobQueueRepository = new Map<number, JobQueue>();
  private server = new EmbedServer();
  private registryThread = new RegistryThread();
  private callbackThread = new CallbackThread();
  private workerPool = new WorkerPool();
  private cleanTimer: ReturnType<typeof setInterval> | null = null;
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: XxlJobExecutorConfig) {
    this.adminAddresses = config.adminAddresses
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    this.appname = config.appname;
    this.accessToken = config.accessToken;
    this.configIp = config.ip;
    this.configPort = config.port;
    this.configAddress = config.address;
    this.logPath =
      config.logPath ?? path.resolve(process.cwd(), 'logs', 'xxl-job', 'jobhandler');
    this.logRetentionDays = config.logRetentionDays ?? 30;
    this.timeoutSec = Math.min(Math.max(config.timeout ?? 3, 1), 10);
  }

  getAddress(): string {
    return this.address;
  }

  matchAuth(accessToken: string, appname: string): boolean {
    return accessToken === this.accessToken && appname === this.appname;
  }

  // ==================== 生命周期 ====================

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.adminAddresses.length) throw new Error('xxl-job: adminAddresses is empty');
    if (!this.appname) throw new Error('xxl-job: appname is empty');
    if (!this.accessToken) throw new Error('xxl-job: accessToken is empty');

    fileAppender.initLogPath(this.logPath);
    JobExecutor.instance = this;

    // 回调线程（先于服务器启动，确保首批结果可上报）
    this.callbackThread.start({
      adminAddresses: this.adminAddresses,
      accessToken: this.accessToken,
      appname: this.appname,
      timeoutSec: this.timeoutSec,
    });

    // 内嵌服务器：监听 0.0.0.0；对外注册地址 = 配置地址或探测的内网 IP
    const port = await this.server.start(this, '0.0.0.0', this.configPort ?? 9999);
    const registryIp = this.configIp ?? getLocalIp();
    this.address = this.configAddress?.replace(/\/+$/, '') ?? `http://${registryIp}:${port}/`;
    this.registryThread.start(
      {
        adminAddresses: this.adminAddresses,
        accessToken: this.accessToken,
        appname: this.appname,
        timeoutSec: this.timeoutSec,
      },
      this.appname,
      this.address,
    );

    // 日志清理（每 6h 一次，幂等）与空闲队列回收（30s 一次）
    if (this.logRetentionDays >= 3) {
      this.cleanTimer = setInterval(
        () => void fileAppender.cleanOldLog(this.logRetentionDays).catch(() => undefined),
        6 * 3600 * 1000,
      );
    }
    this.idleSweepTimer = setInterval(() => this.sweepIdleQueue(), 30_000);

    this.started = true;
    console.log(`[xxl-job] executor started, address=${this.address}, appname=${this.appname}`);
  }

  async destroy(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    // 1. 停服务器 + 摘除注册
    await this.server.stop();
    await this.registryThread.stop();

    // 2. 优雅等待运行中任务
    await sleep(ELEGANT_SHUTDOWN_WAITING_SECONDS * 1000);

    // 3. 终止全部队列（未执行的逐个回调失败）+ 终止全部 worker
    for (const [jobId, queue] of this.jobQueueRepository) {
      queue.kill('web container destroy and kill the job.');
      this.jobQueueRepository.delete(jobId);
    }
    this.workerPool.terminateAll();

    // 4. 停回调线程（flush 剩余结果）
    await this.callbackThread.stop();

    if (this.cleanTimer) clearInterval(this.cleanTimer);
    if (this.idleSweepTimer) clearInterval(this.idleSweepTimer);
    if (JobExecutor.instance === this) JobExecutor.instance = null;
    console.log('[xxl-job] executor destroyed.');
  }

  // ==================== handler 注册 ====================

  registerJobHandler(name: string, handler: JobHandler): this {
    if (!name) throw new Error('xxl-job: jobhandler name is empty');
    if (this.jobHandlerRepository.has(name)) {
      throw new Error(`xxl-job: jobhandler[${name}] conflicts`);
    }
    this.jobHandlerRepository.set(name, handler);
    return this;
  }

  /** 扫描 @XxlJob 装饰器标注的方法（等价 Spring 环境的注解扫描） */
  scanBean(instance: object): this {
    for (const meta of getJobMethodMeta(instance)) {
      const fn = (instance as Record<string | symbol, unknown>)[meta.key];
      if (typeof fn !== 'function') continue;
      this.registerJobHandler(meta.name, async () => {
        await (fn as () => unknown | Promise<unknown>).call(instance);
      });
    }
    return this;
  }

  /**
   * 注册 worker 线程任务（CPU 密集场景）：
   * 任务在独立 worker_threads 中执行，超时/终止会 worker.terminate() 真正杀掉，
   * 不阻塞执行器事件循环。workerFile 内使用 runAsWorker() 暴露任务函数。
   */
  registerJobWorker(name: string, workerFile: string): this {
    if (!name) throw new Error('xxl-job: worker jobhandler name is empty');
    if (this.jobHandlerRepository.has(name) || this.workerHandlerRepository.has(name)) {
      throw new Error(`xxl-job: jobhandler[${name}] conflicts`);
    }
    this.workerHandlerRepository.set(name, workerFile);
    return this;
  }

  // ==================== EmbedServer 端点实现 ====================

  beat(): Response<string> {
    return { code: CODE_SUCCESS, msg: 'success' };
  }

  idleBeat(req: { jobId: number }): Response<string> {
    const queue = this.jobQueueRepository.get(req.jobId);
    if (queue?.isRunningOrHasQueue()) {
      return { code: CODE_FAIL, msg: 'job is running' };
    }
    return { code: CODE_SUCCESS, msg: 'success' };
  }

  trigger(req: TriggerRequest): Response<string> {
    try {
      if (!this.workerHandlerRepository.has(req.executorHandler)) {
        this.resolveHandler(req);
      }
    } catch (e) {
      return { code: CODE_FAIL, msg: e instanceof Error ? e.message : String(e) };
    }
    const queue = this.getOrCreateQueue(req.jobId);
    return queue.push(req);
  }

  kill(req: { jobId: number }): Response<string> {
    const queue = this.jobQueueRepository.get(req.jobId);
    if (!queue) return { code: CODE_SUCCESS, msg: 'job queue already killed' };
    queue.kill('scheduling center kill job.');
    this.jobQueueRepository.delete(req.jobId);
    return { code: CODE_SUCCESS, msg: 'success' };
  }

  async log(req: { logDateTim: number; logId: number; fromLineNum: number }): Promise<Response<LogData>> {
    const logFileName = fileAppender.makeLogFileName(
      new Date(req.logDateTim > 0 ? req.logDateTim : Date.now()),
      req.logId,
    );
    const data = await fileAppender.readLog(logFileName, req.fromLineNum);
    return { code: CODE_SUCCESS, msg: 'success', data: data ?? undefined };
  }

  // ==================== 内部 ====================

  private getOrCreateQueue(jobId: number): JobQueue {
    let queue = this.jobQueueRepository.get(jobId);
    if (!queue) {
      queue = new JobQueue(jobId, (req, controller) => this.executeOne(req, controller), (cb) =>
        this.callbackThread.push(cb),
      );
      this.jobQueueRepository.set(jobId, queue);
    }
    return queue;
  }

  private sweepIdleQueue(): void {
    for (const [jobId, queue] of this.jobQueueRepository) {
      if (queue.isIdle() && queue.getIdleMs() > IDLE_QUEUE_RECYCLE_MS) {
        this.jobQueueRepository.delete(jobId);
      }
    }
  }

  private resolveHandler(req: TriggerRequest): JobHandler {
    if (!req.glueType || req.glueType === 'BEAN') {
      const handler = this.jobHandlerRepository.get(req.executorHandler);
      if (!handler) throw new Error(`job handler not found: [${req.executorHandler}]`);
      return handler;
    }
    if (isScriptGlue(req.glueType)) return this.buildScriptHandler(req);
    throw new Error(`glueType[${req.glueType}] invalid`);
  }

  private buildScriptHandler(req: TriggerRequest): JobHandler {
    const info = GLUE_TYPES[req.glueType];
    if (!info?.isScript || !info.cmd || !info.suffix) {
      throw new Error(`glueType[${req.glueType}] invalid`);
    }
    const cmd = info.cmd;
    const suffix = info.suffix;
    return async (signal: AbortSignal) => {
      const scriptFile = path.join(
        fileAppender.getGlueSrcPath(),
        `${req.jobId}_${req.glueUpdatetime}${suffix}`,
      );
      if (!fs.existsSync(scriptFile)) {
        await fileAppender.markScriptFile(scriptFile, req.glueSource ?? '');
      }
      const ctx = XxlJobHelper.requireCtx();
      await XxlJobHelper.log(`----------- script file: ${scriptFile} -----------`);
      const exitCode = await execToFile(
        cmd,
        scriptFile,
        ctx.logFileName,
        [XxlJobHelper.getJobParam() ?? '', String(ctx.shardIndex), String(ctx.shardTotal)],
        signal,
      );
      if (exitCode === 0) XxlJobHelper.handleSuccess();
      else XxlJobHelper.handleFail(`script exit value(${exitCode}) is failed`);
    };
  }

  private async executeOne(req: TriggerRequest, controller: AbortController): Promise<CallbackData> {
    const triggerDate = new Date(req.logDateTime > 0 ? req.logDateTime : Date.now());
    const ctx: XxlJobContext = {
      jobId: req.jobId,
      logId: req.logId,
      logDateTime: req.logDateTime,
      executorParams: req.executorParams ?? '',
      logFileName: fileAppender.makeLogFileName(triggerDate, req.logId),
      shardIndex: req.broadcastIndex ?? 0,
      shardTotal: req.broadcastTotal ?? 1,
      handleCode: 0,
      handleMsg: '',
      abortSignal: controller.signal,
    };

    await XxlJobContextStorage.run(ctx, async () => {
      await XxlJobHelper.log(
        `----------- xxl-job job execute start -----------\n----------- Param: ${ctx.executorParams}`,
      );

      // worker 线程任务：独立线程执行，超时/终止 = worker.terminate() 真杀
      const workerFile = this.workerHandlerRepository.get(req.executorHandler);
      if (workerFile) {
        const result = await this.workerPool.run(
          req.jobId,
          workerFile,
          { jobId: req.jobId, logId: req.logId, executorParams: ctx.executorParams, shardIndex: ctx.shardIndex, shardTotal: ctx.shardTotal },
          ctx.logFileName,
          controller.signal,
          req.executorTimeout,
        );
        ctx.handleCode = result.handleCode;
        ctx.handleMsg = result.handleMsg;
      } else {
        try {
          const handler = this.resolveHandler(req);
          if (req.executorTimeout > 0) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const task = (async () => {
                await handler(controller.signal);
              })();
              task.catch(() => undefined); // 超时后被放弃的任务不允许产生 unhandledRejection
              const ret = await Promise.race([
                task.then(() => 'DONE' as const),
                new Promise<'TIMEOUT'>((resolve) => {
                  timer = setTimeout(() => resolve('TIMEOUT'), req.executorTimeout * 1000);
                }),
              ]);
              if (ret === 'TIMEOUT') {
                controller.abort();
                XxlJobHelper.handleTimeout('job execute timeout');
              }
            } finally {
              clearTimeout(timer);
            }
          } else {
            await handler(controller.signal);
          }
        } catch (e) {
          XxlJobHelper.handleFail(e instanceof Error ? (e.stack ?? String(e)) : String(e));
        }
      }
      if (ctx.handleCode === 0) XxlJobHelper.handleSuccess();
      await XxlJobHelper.log('----------- xxl-job job execute end(finish) -----------');
    });

    return {
      logId: req.logId,
      logDateTime: req.logDateTime,
      handleCode: ctx.handleCode,
      handleMsg: ctx.handleMsg.length > 2000 ? `${ctx.handleMsg.slice(0, 2000)}...` : ctx.handleMsg,
    };
  }
}
