import { DEAD_TIMEOUT, BEAT_TIMEOUT, formatDateTime } from '@xxl-job-node/core';
import type { CallbackData, RegistryRequest } from '@xxl-job-node/core';
import { config } from '../config.js';
import { jobGroupDao, jobRegistryDao, jobLogDao, jobLogReportDao, jobInfoDao } from '../dao/index.js';
import type { XxlJobGroup, XxlJobLog } from '../db/entities.js';
import { createLimiter } from '../scheduler/TriggerPool.js';
import { trigger, triggerChildJobs, TriggerTypeEnum } from '../scheduler/JobTrigger.js';

/** 各 Helper 共享的组缓存（appname → group），openapi 鉴权与触发链路使用 */
export class GroupCache {
  private byAppname = new Map<string, XxlJobGroup>();
  private byId = new Map<number, XxlJobGroup>();
  private loadedAt = 0;

  async refresh(): Promise<void> {
    const groups = await jobGroupDao.listAll();
    const byAppname = new Map<string, XxlJobGroup>();
    const byId = new Map<number, XxlJobGroup>();
    for (const g of groups) {
      byAppname.set(g.app_name, g);
      byId.set(g.id, g);
    }
    this.byAppname = byAppname;
    this.byId = byId;
    this.loadedAt = Date.now();
  }

  get ageMs(): number {
    return Date.now() - this.loadedAt;
  }

  byAppnameOf(appname: string): XxlJobGroup | undefined {
    return this.byAppname.get(appname);
  }

  byIdOf(id: number): XxlJobGroup | undefined {
    return this.byId.get(id);
  }
}

export const groupCache = new GroupCache();

/** 循环器：间隔轮询 + 异常只记日志 */
function loop(name: string, intervalMs: number, fn: () => Promise<void>): { stop: () => void } {
  const timer = setInterval(() => {
    fn().catch((e) => console.error(`[${name}] error:`, e instanceof Error ? e.message : e));
  }, intervalMs);
  void fn().catch(() => undefined);
  return { stop: () => clearInterval(timer) };
}

// ==================== RegistryHelper：注册发现 ====================

export class RegistryHelper {
  private handle: { stop: () => void } | null = null;

  start(): void {
    this.handle = loop('registry', BEAT_TIMEOUT * 1000, async () => {
      // 1. 清理死注册（90s 无心跳）
      const removed = await jobRegistryDao.removeDead(DEAD_TIMEOUT);
      if (removed > 0) console.log(`[registry] removed ${removed} dead executor(s).`);

      // 2. 聚合存活执行器地址 → 回写自动注册组
      const all = await jobRegistryDao.findAll();
      const byAppname = new Map<string, Set<string>>();
      for (const item of all) {
        if (item.registry_group !== 'EXECUTOR') continue;
        const set = byAppname.get(item.registry_key) ?? new Set<string>();
        set.add(item.registry_value);
        byAppname.set(item.registry_key, set);
      }
      for (const [appname, addresses] of byAppname) {
        const addressList = [...addresses].sort().join(',');
        await jobGroupDao.updateAddressList(appname, addressList);
      }

      // 3. 刷新组缓存（供 openapi 鉴权用）
      await groupCache.refresh();
    });
  }

  stop(): void {
    this.handle?.stop();
  }

  /** executor 心跳上报（openapi 转发） */
  async registry(req: RegistryRequest): Promise<void> {
    await jobRegistryDao.saveOrUpdate(req.registryGroup, req.registryKey, req.registryValue);
  }

  /** 优雅摘除 */
  async registryRemove(req: RegistryRequest): Promise<void> {
    await jobRegistryDao.remove(req.registryGroup, req.registryKey, req.registryValue);
  }
}

// ==================== CompleteHelper：回调处理 + 丢失兜底 ====================

export class CompleteHelper {
  private callbackLimit = createLimiter(20);
  private monitorHandle: { stop: () => void } | null = null;

  start(): void {
    this.monitorHandle = loop('complete-monitor', 60_000, async () => {
      // 丢失兜底：trigger 成功、10 分钟无回调、且执行器已离线 → 标记失败
      const deadLine = formatDateTime(new Date(Date.now() - 10 * 60_000));
      const ids = await jobLogDao.findLostJobIds(deadLine, 500);
      for (const id of ids) {
        await jobLogDao.updateHandleInfo(id, 500, 'joblog_lost_fail：执行结果丢失（执行器离线且无回调）', 1);
      }
    });
  }

  stop(): void {
    this.monitorHandle?.stop();
  }

  /** executor 回调入口（openapi 转发）：并发处理 + 完成语义（子任务级联） */
  async callback(list: CallbackData[]): Promise<void> {
    await Promise.all(
      list.map((data) =>
        this.callbackLimit(async () => {
          const log = await jobLogDao.load(data.logId);
          if (!log) return;
          if (log.handle_code > 0) return; // 重复回调幂等跳过
          await this.complete(log, data);
        }),
      ),
    );
  }

  private async complete(log: XxlJobLog, data: CallbackData): Promise<void> {
    const childMsg = await this.completeAndCascade(log, data);
    const finalMsg = childMsg ? `${data.handleMsg}\n${childMsg}` : data.handleMsg;
    await jobLogDao.updateHandleInfo(log.id, data.handleCode, finalMsg, 1);
  }

  private async completeAndCascade(log: XxlJobLog, data: CallbackData): Promise<string> {
    if (data.handleCode !== 200) return '';
    const job = await jobInfoDao.load(log.job_id);
    if (!job?.child_jobid?.trim()) return '';
    return triggerChildJobs(job.child_jobid, log);
  }
}

// ==================== AlarmHelper：失败告警 + 失败重试 ====================

export interface JobAlarm {
  /** 返回 true 表示告警成功 */
  alarm(jobName: string, alarmEmail: string, log: XxlJobLog, failMsg: string): Promise<boolean>;
}

/** 默认告警渠道：控制台输出（可扩展邮件/webhook） */
export class ConsoleAlarm implements JobAlarm {
  async alarm(jobName: string, alarmEmail: string, log: XxlJobLog, failMsg: string): Promise<boolean> {
    console.error(
      `[alarm] 任务[${jobName}](${log.job_id}) 执行失败 logId=${log.id} 通知=${alarmEmail || '-'}: ${failMsg.slice(0, 200)}`,
    );
    return true;
  }
}

export class AlarmHelper {
  private handle: { stop: () => void } | null = null;

  constructor(private alarms: JobAlarm[]) {}

  start(): void {
    this.handle = loop('alarm', 10_000, async () => {
      const ids = await jobLogDao.findFailJobLogIds(1000);
      for (const id of ids) {
        // CAS 抢锁（0 → -1），多 admin 集群不重复告警/重试
        const locked = await jobLogDao.casAlarmStatus(id, 0, -1);
        if (!locked) continue;
        await this.alarmOne(id);
      }
    });
  }

  stop(): void {
    this.handle?.stop();
  }

  private async alarmOne(id: number): Promise<void> {
    const log = await jobLogDao.load(id);
    if (!log) return;
    const job = await jobInfoDao.load(log.job_id);

    // ① 失败重试（次数-1 递减，RETRY 类型）
    let retryMsg = '';
    if (job && log.executor_fail_retry_count > 0) {
      await trigger(job.id, {
        triggerType: TriggerTypeEnum.RETRY,
        failRetryCount: log.executor_fail_retry_count - 1,
        shardingParam: log.executor_sharding_param,
        executorParam: log.executor_param,
      });
      retryMsg = `失败重试已触发（剩余 ${log.executor_fail_retry_count - 1} 次）`;
    }

    // ② 告警（任一渠道成功即成功）
    let alarmOk = false;
    if (job) {
      const failMsg = `${log.trigger_msg ?? ''}\n${log.handle_msg ?? ''}`;
      for (const alarm of this.alarms) {
        try {
          if (await alarm.alarm(job.name, job.alarm_email ?? '', log, failMsg)) {
            alarmOk = true;
            break;
          }
        } catch {
          // 尝试下一渠道
        }
      }
    }
    await jobLogDao.casAlarmStatus(id, -1, alarmOk ? 2 : 3);
  }
}

// ==================== LogReportHelper：报表聚合 + 日志清理 ====================

export class LogReportHelper {
  private handle: { stop: () => void } | null = null;
  private lastCleanAt = 0;

  start(): void {
    this.handle = loop('log-report', 60_000, async () => {
      // 重刷近 3 天报表
      for (let i = 0; i < 3; i++) {
        const day = new Date(Date.now() - i * 24 * 3600_000);
        const dayStr = day.toISOString().slice(0, 10);
        const agg = await jobLogReportDao.aggregate(dayStr);
        await jobLogReportDao.saveOrUpdate(dayStr, agg.running, agg.suc, agg.fail);
      }
      // 日志清理：每天一次
      if (config.logRetentionDays >= 3 && Date.now() - this.lastCleanAt > 24 * 3600_000) {
        this.lastCleanAt = Date.now();
        const before = new Date(Date.now() - config.logRetentionDays * 24 * 3600_000);
        const beforeTime = formatDateTime(before);
        const jobs = await jobInfoDao.pageList({ start: 0, length: 10_000 });
        const ids = jobs.rows.map((j) => j.id);
        let cleared = 0;
        for (;;) {
          const batch = await jobLogDao.findClearLogIds(ids, beforeTime, 1000);
          if (!batch.length) break;
          await jobLogDao.clearLog(batch);
          cleared += batch.length;
        }
        if (cleared > 0) console.log(`[log-report] cleared ${cleared} old log(s).`);
      }
    });
  }

  stop(): void {
    this.handle?.stop();
  }
}

