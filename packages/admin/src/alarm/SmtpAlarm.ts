import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { JobAlarm } from '../scheduler/helpers.js';
import type { XxlJobLog } from '../db/entities.js';
import { formatDateTime } from '@xxl-job-node/core';

const smtpConfig = {
  host: process.env.XXL_JOB_SMTP_HOST ?? '',
  port: Number(process.env.XXL_JOB_SMTP_PORT ?? 465),
  secure: (process.env.XXL_JOB_SMTP_SSL ?? 'true') === 'true',
  user: process.env.XXL_JOB_SMTP_USER ?? '',
  pass: process.env.XXL_JOB_SMTP_PASS ?? '',
  from: process.env.XXL_JOB_SMTP_FROM ?? process.env.XXL_JOB_SMTP_USER ?? '',
};

/**
 * 邮件告警渠道。需配置 XXL_JOB_SMTP_HOST/PORT/USER/PASS/FROM 环境变量，
 * 未配置时 buildApp 不注册此渠道（自动降级控制台输出）。
 */
export class SmtpAlarm implements JobAlarm {
  private transporter: Transporter | null = null;

  constructor() {
    if (smtpConfig.host && smtpConfig.user) {
      this.transporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        auth: { user: smtpConfig.user, pass: smtpConfig.pass },
      });
    }
  }

  static get enabled(): boolean {
    return Boolean(smtpConfig.host && smtpConfig.user);
  }

  async alarm(jobName: string, alarmEmail: string, log: XxlJobLog, failMsg: string): Promise<boolean> {
    if (!this.transporter || !alarmEmail?.trim()) return false;
    const recipients = alarmEmail.split(',').map((s) => s.trim()).filter(Boolean);
    if (!recipients.length) return false;

    const subject = `XXL-JOB Node 任务告警：${jobName}`;
    const html = [
      `<h3>任务执行失败告警</h3>`,
      `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">`,
      `<tr><td>任务</td><td>${jobName} (#${log.job_id})</td></tr>`,
      `<tr><td>日志 ID</td><td>${log.id}</td></tr>`,
      `<tr><td>调度时间</td><td>${log.trigger_time ?? '-'}</td></tr>`,
      `<tr><td>执行器</td><td>${log.executor_address ?? '-'}</td></tr>`,
      `<tr><td>告警时间</td><td>${formatDateTime(new Date())}</td></tr>`,
      `</table>`,
      `<pre style="white-space:pre-wrap;background:#f6f6f6;padding:12px">${escapeHtml(failMsg).slice(0, 4000)}</pre>`,
    ].join('\n');

    await this.transporter.sendMail({
      from: smtpConfig.from,
      to: recipients.join(','),
      subject,
      html,
    });
    return true;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
