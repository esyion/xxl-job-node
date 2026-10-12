import { formatDateTime } from '@xxl-job-node/core';
import type { GlueType } from '@xxl-job-node/core';
import type { XxlJobGroup, XxlJobInfo, XxlJobLog } from '../db/entities.js';
import { jobGroupDao, jobInfoDao, jobLogDao } from '../dao/index.js';
import { route } from './routes.js';
import { postJson } from './executorClient.js';
import { config } from '../config.js';

export enum TriggerTypeEnum {
  CRON = 'CRON',
  MANUAL = 'MANUAL',
  RETRY = 'RETRY',
  PARENT = 'PARENT',
  MISFIRE = 'MISFIRE',
}

export interface TriggerOptions {
  triggerType: TriggerTypeEnum;
  /** 覆盖失败重试次数（重试递减用），-1 = 用任务配置 */
  failRetryCount?: number;
  /** 分片参数 "idx/total"（重试透传 / 手动指定） */
  shardingParam?: string | null;
  /** 覆盖执行参数 */
  executorParam?: string | null;
  /** 覆盖地址列表（手动指定执行器地址） */
  addressList?: string | null;
}

/**
 * 触发链路：先落日志拿 logId → 路由选址 → HTTP 触发 → 回写 trigger 侧信息。
 * logId 是全链路幂等键（执行器去重、回调定位、日志文件名都依赖它）。
 */
export async function trigger(jobId: number, opts: TriggerOptions): Promise<void> {
  const job = await jobInfoDao.load(jobId);
  if (!job) return;
  const group = await jobGroupDao.load(job.job_group);
  if (!group) return;

  // 地址列表：手动覆盖 > 组注册列表
  const addressList = opts.addressList
    ? opts.addressList.split(',').map((s) => s.trim()).filter(Boolean)
    : group.registryList();

  if (job.executor_route_strategy === 'SHARDING_BROADCAST' && !opts.shardingParam) {
    // 分片广播：逐台展开为 N 次触发
    for (let i = 0; i < addressList.length; i++) {
      await processTrigger(job, group, opts, `${i}/${addressList.length}`);
    }
    return;
  }
  let sharding: [number, number] = [0, 1];
  if (opts.shardingParam) {
    const parts = opts.shardingParam.split('/');
    if (parts.length === 2) {
      sharding = [Number(parts[0]), Number(parts[1])];
    }
  }
  await processTrigger(job, group, opts, sharding[1] > 1 ? opts.shardingParam ?? null : null);
}

async function processTrigger(
  job: XxlJobInfo,
  group: XxlJobGroup,
  opts: TriggerOptions,
  shardingParam: string | null,
): Promise<void> {
  const [shardIndex, shardTotal] = (() => {
    if (!shardingParam) return [0, 1];
    const parts = shardingParam.split('/');
    return parts.length === 2 ? [Number(parts[0]), Number(parts[1])] : [0, 1];
  })();

  const retryCount =
    opts.failRetryCount !== undefined && opts.failRetryCount >= 0
      ? opts.failRetryCount
      : job.executor_fail_retry_count;

  const triggerRequest = {
    jobId: job.id,
    executorHandler: job.executor_handler ?? '',
    executorParams: opts.executorParam ?? job.executor_param ?? '',
    executorBlockStrategy: job.executor_block_strategy,
    executorTimeout: job.executor_timeout,
    logId: 0,
    logDateTime: 0,
    glueType: (job.glue_type || 'BEAN') as GlueType,
    glueSource: job.glue_source ?? '',
    glueUpdatetime: job.glue_updatetime ? new Date(job.glue_updatetime).getTime() : 0,
    broadcastIndex: shardIndex,
    broadcastTotal: shardTotal,
  };

  // 1. 先落一条调度日志（logId = 全链路幂等键）
  const logId = await jobLogDao.addTriggerLog({
    job_group: job.job_group,
    job_id: job.id,
    executor_address: null,
    executor_handler: job.executor_handler,
    executor_param: triggerRequest.executorParams,
    executor_sharding_param: shardingParam,
    executor_fail_retry_count: retryCount,
    trigger_time: formatDateTime(new Date()),
  });

  // 2. 路由选址（SHARDING_BROADCAST 走下标直取，其余走策略）
  const addressList = opts.addressList
    ? opts.addressList.split(',').map((s) => s.trim()).filter(Boolean)
    : group.registryList();

  let address: string | null = null;
  if (!addressList.length) {
    await jobLogDao.updateTriggerInfo(
      logId, 500, `调度失败：执行器地址为空（appname=${group.app_name}）`, null,
      job.executor_handler, triggerRequest.executorParams, shardingParam, retryCount,
    );
    return;
  }
  if (job.executor_route_strategy === 'SHARDING_BROADCAST') {
    address = addressList[shardIndex] ?? addressList[0] ?? null;
  } else {
    address = await route(job.executor_route_strategy ?? 'FIRST', {
      group: { ...group, address_list: addressList.join(','), registryList: () => addressList } as XxlJobGroup,
      triggerRequest: { ...triggerRequest, logId, logDateTime: Date.now() },
      timeoutSec: config.trigger.rpcTimeoutSec,
    });
  }
  if (!address) {
    await jobLogDao.updateTriggerInfo(
      logId, 500, '调度失败：路由未选中可用执行器地址', null,
      job.executor_handler, triggerRequest.executorParams, shardingParam, retryCount,
    );
    return;
  }

  // 3. HTTP 触发
  triggerRequest.logId = logId;
  triggerRequest.logDateTime = Date.now();
  const res = await postJson<unknown>(
    `${address.replace(/\/+$/, '')}/trigger`,
    triggerRequest,
    group,
    config.trigger.rpcTimeoutSec,
  );

  const triggerMsg = [
    `地址：${address}`,
    `路由策略：${job.executor_route_strategy}`,
    `阻塞策略：${job.executor_block_strategy}`,
    `分片参数：${shardingParam ?? '-'}`,
    `触发类型：${opts.triggerType}`,
    res ? `执行器响应：code=${res.code} msg=${res.msg}` : '执行器响应：请求失败（超时或连接拒绝）',
  ].join('<br>');

  await jobLogDao.updateTriggerInfo(
    logId,
    res?.code ?? 500,
    triggerMsg,
    address,
    job.executor_handler,
    triggerRequest.executorParams,
    shardingParam,
    retryCount,
  );
}

/** 子任务级联：父任务成功后触发子任务 */
export async function triggerChildJobs(childJobIds: string, log: XxlJobLog): Promise<string> {
  if (!childJobIds?.trim()) return '';
  const messages: string[] = [];
  for (const idStr of childJobIds.split(',')) {
    const childId = Number(idStr.trim());
    if (!childId || childId === log.job_id) continue; // 自我循环跳过
    const child = await jobInfoDao.load(childId);
    if (!child) {
      messages.push(`子任务[${childId}]不存在`);
      continue;
    }
    await trigger(childId, { triggerType: TriggerTypeEnum.PARENT });
    messages.push(`子任务[${childId}]已触发`);
  }
  return messages.join('<br>');
}
