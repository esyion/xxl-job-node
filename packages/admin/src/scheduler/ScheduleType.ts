import { Cron } from 'croner';
import type { XxlJobInfo } from '../db/entities.js';

/**
 * 调度类型：计算下次触发时间。
 * - CRON：Quartz 风格 7 域（秒 分 时 日 月 周 年），兼容 ?
 * - FIX_RATE：固定频率（秒），从基准时间累加并对齐秒边界
 */
export function generateNextTriggerTime(job: XxlJobInfo, fromTime: Date): number | null {
  if (job.schedule_type === 'CRON') {
    return nextByCron(job.schedule_conf ?? '', fromTime);
  }
  if (job.schedule_type === 'FIX_RATE') {
    return nextByFixRate(job.schedule_conf ?? '', fromTime);
  }
  return null;
}

/**
 * Quartz 7 域（含年）与 `?` 通配归一化为 croner 兼容的 6 域。
 * xxl-job 标准 cron 为 7 域（秒 分 时 日 月 周 年），croner 只认 5/6 域且不支持 `?`；
 * 年位仅作兼容丢弃，`?` 按 Quartz 语义视作 `*`（另一侧的具体值仍生效）。
 */
export function normalizeCron(cron: string): string {
  const parts = cron.trim().replace(/\s+/g, ' ').split(' ');
  const six = parts.length === 7 ? parts.slice(0, 6) : parts;
  return six.map((p) => (p === '?' ? '*' : p)).join(' ');
}

export function nextByCron(cron: string, fromTime: Date): number | null {
  const conf = normalizeCron(cron);
  if (!conf) return null;
  try {
    const instance = new Cron(conf);
    const next = instance.nextRun(fromTime);
    return next ? next.getTime() : null;
  } catch {
    return null;
  }
}

export function nextByFixRate(conf: string, fromTime: Date): number | null {
  const rateSec = Number(conf);
  if (!Number.isFinite(rateSec) || rateSec <= 0) return null;
  const nextMs = fromTime.getTime() + rateSec * 1000;
  // 毫秒进位对齐到下一秒边界
  return nextMs % 1000 === 0 ? nextMs : Math.ceil(nextMs / 1000) * 1000;
}

/** 校验调度配置合法（表单用），返回错误信息或 null */
export function validateScheduleConf(type: string, conf: string): string | null {
  if (type === 'CRON') {
    if (!conf) return '请输入 Cron 表达式';
    try {
      new Cron(normalizeCron(conf));
      return null;
    } catch {
      return 'Cron 表达式不合法';
    }
  }
  if (type === 'FIX_RATE') {
    const n = Number(conf);
    if (!Number.isFinite(n) || n < 1) return '固定频率必须为不小于 1 的秒数';
    return null;
  }
  return null;
}

/** 预览未来 N 次触发时间（前端“下次执行时间”功能） */
export function previewNextTimes(type: string, conf: string, count = 5): number[] {
  const fakeJob = { schedule_type: type, schedule_conf: conf } as XxlJobInfo;
  const times: number[] = [];
  let from = new Date();
  for (let i = 0; i < count; i++) {
    const next = generateNextTriggerTime(fakeJob, from);
    if (next === null) break;
    times.push(next);
    from = new Date(next);
  }
  return times;
}
