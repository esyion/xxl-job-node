import { formatDateTime } from '@xxl-job-node/core';
import { jobInfoDao, jobGroupDao } from '../dao/index.js';
import type { XxlJobInfo } from '../db/entities.js';
import { validateScheduleConf, generateNextTriggerTime } from '../scheduler/ScheduleType.js';
import { PRE_READ_MS } from '@xxl-job-node/core';

export type JobPayload = Partial<XxlJobInfo> & { id?: number };

/** 任务定义校验 + 落库（对齐 Java 版 XxlJobServiceImpl 的关键校验） */
export const jobService = {
  validate(payload: JobPayload): string | null {
    if (!payload.job_group || payload.job_group <= 0) return '请选择执行器';
    const group = jobGroupDao.load(payload.job_group);
    if (!group) return '执行器不存在';
    if (!payload.name?.trim()) return '请输入任务名称';
    const scheduleType = payload.schedule_type ?? 'NONE';
    if (!['NONE', 'CRON', 'FIX_RATE'].includes(scheduleType)) return '调度类型不合法';
    const confError = validateScheduleConf(scheduleType, payload.schedule_conf ?? '');
    if (confError) return confError;
    const glueType = payload.glue_type ?? 'BEAN';
    if (glueType === 'BEAN' && !payload.executor_handler?.trim()) return '请输入 JobHandler';
    if (glueType !== 'BEAN' && (payload.glue_source ?? '').trim() === '') return '请输入脚本源码';
    return null;
  },

  async add(payload: JobPayload): Promise<number> {
    const id = await jobInfoDao.insert({
      ...payload,
      glue_type: payload.glue_type ?? 'BEAN',
      glue_updatetime: (payload.glue_type ?? 'BEAN') !== 'BEAN' ? formatDateTime(new Date()) : null,
    });
    return id;
  },

  async update(payload: JobPayload): Promise<void> {
    const exists = await jobInfoDao.load(payload.id ?? 0);
    if (!exists) throw new Error('任务不存在');
    const merged: XxlJobInfo = {
      ...exists,
      job_group: payload.job_group ?? exists.job_group,
      name: payload.name ?? exists.name,
      author: payload.author ?? exists.author,
      alarm_email: payload.alarm_email ?? exists.alarm_email,
      schedule_type: payload.schedule_type ?? exists.schedule_type,
      schedule_conf: payload.schedule_conf ?? exists.schedule_conf,
      misfire_strategy: payload.misfire_strategy ?? exists.misfire_strategy,
      executor_route_strategy: payload.executor_route_strategy ?? exists.executor_route_strategy,
      executor_handler: payload.executor_handler ?? exists.executor_handler,
      executor_param: payload.executor_param ?? exists.executor_param,
      executor_block_strategy: payload.executor_block_strategy ?? exists.executor_block_strategy,
      executor_timeout: payload.executor_timeout ?? exists.executor_timeout,
      executor_fail_retry_count: payload.executor_fail_retry_count ?? exists.executor_fail_retry_count,
      glue_type: payload.glue_type ?? exists.glue_type,
      child_jobid: payload.child_jobid ?? exists.child_jobid,
    };
    if (merged.glue_type !== 'BEAN' && (payload.glue_source ?? '') !== '') {
      merged.glue_source = payload.glue_source ?? '';
      merged.glue_updatetime = formatDateTime(new Date());
    }
    await jobInfoDao.update(merged);
  },

  async remove(id: number): Promise<void> {
    const exists = await jobInfoDao.load(id);
    if (!exists) throw new Error('任务不存在');
    if (exists.trigger_status === 1) throw new Error('请先停止任务再删除');
    await jobInfoDao.remove(id);
  },

  /** 启动：next 从 now+5s（预读窗口）起算，避免启动瞬间 misfire */
  async start(id: number): Promise<void> {
    const job = await jobInfoDao.load(id);
    if (!job) throw new Error('任务不存在');
    if (job.trigger_status === 1) return;
    if (job.schedule_type === 'NONE') throw new Error('调度类型为 NONE 的任务无法启动');
    const next = generateNextTriggerTime(job, new Date(Date.now() + PRE_READ_MS));
    if (next === null) throw new Error('调度配置不合法，无法计算下次触发时间');
    await jobInfoDao.updateStatus(id, 1, Date.now(), next);
  },

  async stop(id: number): Promise<void> {
    const job = await jobInfoDao.load(id);
    if (!job) throw new Error('任务不存在');
    if (job.trigger_status === 0) return;
    await jobInfoDao.updateStatus(id, 0, Date.now(), 0);
  },
};
