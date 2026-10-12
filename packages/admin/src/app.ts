import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { HEADER_ACCESS_TOKEN, HEADER_APPNAME } from '@xxl-job-node/core';
import type { CallbackRequest, RegistryRequest } from '@xxl-job-node/core';
import { config } from './config.js';
import {
  jobGroupDao,
  jobInfoDao,
  jobLogDao,
  jobLogReportDao,
  jobUserDao,
} from './dao/index.js';
import type { XxlJobGroup, XxlJobInfo } from './db/entities.js';
import { jobService } from './service/JobService.js';
import { trigger, TriggerTypeEnum } from './scheduler/JobTrigger.js';
import { previewNextTimes } from './scheduler/ScheduleType.js';
import { ROUTE_STRATEGIES } from './scheduler/routes.js';
import {
  groupCache,
  RegistryHelper,
  CompleteHelper,
  AlarmHelper,
  LogReportHelper,
  ConsoleAlarm,
} from './scheduler/helpers.js';
import { SmtpAlarm } from './alarm/SmtpAlarm.js';
import { postJson } from './scheduler/executorClient.js';
import { sessions, requireSession, visibleGroupIds, hasGroupPermission } from './api/session.js';
import { registerOpenapiJobRoutes } from './api/openapiJobs.js';
import { registerUserRoutes } from './api/users.js';
import { registerGlueRoutes } from './api/glue.js';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function ok<T>(data?: T): { code: number; msg: string; data?: T } {
  return { code: 200, msg: 'success', data };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function buildApp(): Promise<{
  app: FastifyInstance;
  registryHelper: RegistryHelper;
  completeHelper: CompleteHelper;
  alarmHelper: AlarmHelper;
  logReportHelper: LogReportHelper;
}> {
  const app = Fastify({ logger: false });
  await app.register(cookie);

  const registryHelper = new RegistryHelper();
  const completeHelper = new CompleteHelper();
  const alarms = SmtpAlarm.enabled ? [new SmtpAlarm(), new ConsoleAlarm()] : [new ConsoleAlarm()];
  const alarmHelper = new AlarmHelper(alarms);
  const logReportHelper = new LogReportHelper();

  // ==================== executor openapi（协议端点，免登录） ====================

  const openapiAuth = (req: FastifyRequest): XxlJobGroup | null => {
    const appname = String(req.headers[HEADER_APPNAME.toLowerCase()] ?? '');
    const token = String(req.headers[HEADER_ACCESS_TOKEN.toLowerCase()] ?? '');
    if (!appname || !token) return null;
    const group = groupCache.byAppnameOf(appname);
    if (!group || group.access_token !== token) return null;
    return group;
  };

  app.post('/api/registry', async (req, reply) => {
    const group = openapiAuth(req);
    if (!group) return reply.send({ code: 500, msg: 'The access token or appname is incorrect.' });
    await registryHelper.registry(req.body as RegistryRequest);
    return reply.send(ok());
  });

  app.post('/api/registryRemove', async (req, reply) => {
    const group = openapiAuth(req);
    if (!group) return reply.send({ code: 500, msg: 'The access token or appname is incorrect.' });
    await registryHelper.registryRemove(req.body as RegistryRequest);
    return reply.send(ok());
  });

  app.post('/api/callback', async (req, reply) => {
    const group = openapiAuth(req);
    if (!group) return reply.send({ code: 500, msg: 'The access token or appname is incorrect.' });
    const body = req.body as CallbackRequest;
    await completeHelper.callback(Array.isArray(body?.data) ? body.data : []);
    return reply.send(ok());
  });

  // ==================== auth ====================

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    if (!username || !password) return reply.code(400).send({ code: 500, msg: '请输入账号密码' });
    const user = await jobUserDao.loadByUsername(username);
    if (!user || user.password !== sha256(password)) {
      return reply.code(401).send({ code: 500, msg: '账号或密码错误' });
    }
    const token = crypto.randomUUID().replaceAll('-', '');
    sessions.set(token, { userId: user.id, username: user.username, role: user.role, permission: user.permission });
    reply.setCookie('xxl_job_session', token, { path: '/', httpOnly: true, sameSite: 'lax' });
    return reply.send(ok({ username: user.username, role: user.role }));
  });

  app.get('/api/auth/me', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    return reply.send(ok(user));
  });

  // 用户管理 / 改密 / 登出
  registerUserRoutes(app);

  // 管理接口统一鉴权
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const openPaths = [
      '/api/auth/login',
      '/api/registry',
      '/api/registryRemove',
      '/api/callback',
      '/api/addJob',
      '/api/updateJob',
      '/api/removeJob',
      '/api/startJob',
      '/api/stopJob',
      '/api/triggerJob',
    ];
    if (openPaths.some((p) => req.url === p || req.url.startsWith(`${p}?`))) return;
    const user = requireSession(req, reply);
    if (!user) throw new Error('unreachable');
  });

  // 第三方任务管理 OpenAPI（双 Header 鉴权 + 令牌桶限流）
  registerOpenapiJobRoutes(app);

  // GLUE 源码版本管理
  registerGlueRoutes(app);

  // ==================== groups（执行器管理） ====================

  app.get('/api/groups', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page ?? 1), 1);
    const size = Math.min(Number(q.size ?? 20), 200);
    const r = await jobGroupDao.pageList({
      appname: q.appname,
      name: q.name,
      start: (page - 1) * size,
      length: size,
    });
    const visible = visibleGroupIds(user);
    const rows = visible === null ? r.rows : r.rows.filter((g) => visible.includes(g.id));
    return reply.send(ok({ total: visible === null ? r.total : rows.length, rows }));
  });

  app.get('/api/groups/all', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const rows = await jobGroupDao.listAll();
    const visible = visibleGroupIds(user);
    return reply.send(ok(visible === null ? rows : rows.filter((g) => visible.includes(g.id))));
  });

  app.post('/api/groups', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    if (user.role !== 1) return reply.code(403).send({ code: 500, msg: '仅管理员可管理执行器' });
    const body = req.body as Partial<XxlJobGroup>;
    if (!body.app_name?.trim()) return reply.code(400).send({ code: 500, msg: '请输入 AppName' });
    if (!body.name?.trim()) return reply.code(400).send({ code: 500, msg: '请输入名称' });
    try {
      const id = await jobGroupDao.insert({
        app_name: body.app_name.trim(),
        name: body.name.trim(),
        address_type: body.address_type ?? 0,
        address_list: body.address_list ?? '',
        access_token: body.access_token ?? 'default_token',
      });
      await groupCache.refresh();
      return reply.send(ok({ id }));
    } catch (e) {
      return reply.code(400).send({ code: 500, msg: errMsg(e) });
    }
  });

  app.put('/api/groups/:id', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    if (user.role !== 1) return reply.code(403).send({ code: 500, msg: '仅管理员可管理执行器' });
    const { id } = req.params as { id: string };
    const body = req.body as Partial<XxlJobGroup>;
    const exists = await jobGroupDao.load(Number(id));
    if (!exists) return reply.code(404).send({ code: 500, msg: '执行器不存在' });
    await jobGroupDao.update({
      ...exists,
      app_name: body.app_name?.trim() ?? exists.app_name,
      name: body.name?.trim() ?? exists.name,
      address_type: body.address_type ?? exists.address_type,
      address_list: body.address_list ?? exists.address_list,
      access_token: body.access_token ?? exists.access_token,
    });
    await groupCache.refresh();
    return reply.send(ok());
  });

  app.delete('/api/groups/:id', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    if (user.role !== 1) return reply.code(403).send({ code: 500, msg: '仅管理员可管理执行器' });
    const { id } = req.params as { id: string };
    const jobs = await jobInfoDao.pageList({ jobGroup: Number(id), start: 0, length: 1 });
    if (jobs.total > 0) return reply.code(400).send({ code: 500, msg: '该执行器下存在任务，禁止删除' });
    await jobGroupDao.remove(Number(id));
    await groupCache.refresh();
    return reply.send(ok());
  });

  // ==================== jobs（任务管理） ====================

  app.get('/api/jobs', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page ?? 1), 1);
    const size = Math.min(Number(q.size ?? 20), 200);
    const r = await jobInfoDao.pageList({
      jobGroup: Number(q.jobGroup ?? 0) || undefined,
      groupIds: visibleGroupIds(user),
      executorHandler: q.executorHandler,
      name: q.name,
      triggerStatus: q.triggerStatus === undefined ? undefined : Number(q.triggerStatus),
      start: (page - 1) * size,
      length: size,
    });
    return reply.send(ok({ total: r.total, rows: r.rows }));
  });

  app.post('/api/jobs', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const payload = req.body as Partial<XxlJobInfo>;
    if (!hasGroupPermission(user, payload.job_group ?? 0)) {
      return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    }
    const error = jobService.validate(payload);
    if (error) return reply.code(400).send({ code: 500, msg: error });
    const id = await jobService.add(payload);
    return reply.send(ok({ id }));
  });

  app.put('/api/jobs/:id', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const { id } = req.params as { id: string };
    const payload = { ...(req.body as Partial<XxlJobInfo>), id: Number(id) };
    const exists = await jobInfoDao.load(Number(id));
    if (!exists) return reply.code(404).send({ code: 500, msg: '任务不存在' });
    if (!hasGroupPermission(user, exists.job_group) || !hasGroupPermission(user, payload.job_group ?? exists.job_group)) {
      return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    }
    const error = jobService.validate(payload);
    if (error) return reply.code(400).send({ code: 500, msg: error });
    if (exists.trigger_status === 1) return reply.code(400).send({ code: 500, msg: '运行中任务禁止修改，请先停止（GLUE 源码可在运行中更新）' });
    await jobService.update(payload);
    return reply.send(ok());
  });

  app.delete('/api/jobs/:id', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const { id } = req.params as { id: string };
    const exists = await jobInfoDao.load(Number(id));
    if (exists && !hasGroupPermission(user, exists.job_group)) {
      return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    }
    try {
      await jobService.remove(Number(id));
      return reply.send(ok());
    } catch (e) {
      return reply.code(400).send({ code: 500, msg: errMsg(e) });
    }
  });

  app.post('/api/jobs/:id/trigger', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { executorParam?: string; addressList?: string };
    const job = await jobInfoDao.load(Number(id));
    if (!job) return reply.code(404).send({ code: 500, msg: '任务不存在' });
    if (!hasGroupPermission(user, job.job_group)) return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    await trigger(Number(id), {
      triggerType: TriggerTypeEnum.MANUAL,
      executorParam: body.executorParam ?? null,
      addressList: body.addressList ?? null,
    });
    return reply.send(ok());
  });

  app.post('/api/jobs/:id/start', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const { id } = req.params as { id: string };
    const job = await jobInfoDao.load(Number(id));
    if (job && !hasGroupPermission(user, job.job_group)) {
      return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    }
    try {
      await jobService.start(Number(id));
      return reply.send(ok());
    } catch (e) {
      return reply.code(400).send({ code: 500, msg: errMsg(e) });
    }
  });

  app.post('/api/jobs/:id/stop', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const { id } = req.params as { id: string };
    const job = await jobInfoDao.load(Number(id));
    if (job && !hasGroupPermission(user, job.job_group)) {
      return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    }
    try {
      await jobService.stop(Number(id));
      return reply.send(ok());
    } catch (e) {
      return reply.code(400).send({ code: 500, msg: errMsg(e) });
    }
  });

  app.get('/api/jobs/next-time', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const times = previewNextTimes(q.scheduleType ?? 'CRON', q.scheduleConf ?? '', Number(q.count ?? 5));
    return ok(times);
  });

  // ==================== logs（调度日志） ====================

  app.get('/api/logs', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page ?? 1), 1);
    const size = Math.min(Number(q.size ?? 20), 200);
    let filterTime: [string, string] | undefined;
    if (q.start && q.end) filterTime = [`${q.start} 00:00:00`, `${q.end} 23:59:59`];
    const r = await jobLogDao.pageList({
      jobGroup: Number(q.jobGroup ?? 0) || undefined,
      groupIds: visibleGroupIds(user),
      jobId: Number(q.jobId ?? 0) || undefined,
      logStatus: q.logStatus === undefined ? undefined : Number(q.logStatus),
      filterTime,
      start: (page - 1) * size,
      length: size,
    });
    return reply.send(ok({ total: r.total, rows: r.rows }));
  });

  app.get('/api/logs/:id/detail', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const { id } = req.params as { id: string };
    const log = await jobLogDao.load(Number(id));
    if (!log) return reply.code(404).send({ code: 500, msg: '日志不存在' });
    if (!hasGroupPermission(user, log.job_group)) return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    return reply.send(ok(log));
  });

  /** 滚动读取执行器日志文件 */
  app.get('/api/logs/:id/content', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    const log = await jobLogDao.load(Number(id));
    if (!log) return reply.code(404).send({ code: 500, msg: '日志不存在' });
    if (!hasGroupPermission(user, log.job_group)) return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    if (!log.executor_address) {
      return reply.send(ok({ fromLineNum: 1, toLineNum: 1, logContent: '该执行未调度到执行器（无执行日志）', isEnd: true }));
    }
    const group = await jobGroupDao.load(log.job_group);
    if (!group) return reply.code(404).send({ code: 500, msg: '执行器组不存在' });
    const res = await postJson<{ fromLineNum: number; toLineNum: number; logContent: string; isEnd: boolean }>(
      `${log.executor_address.replace(/\/+$/, '')}/log`,
      {
        logDateTim: log.trigger_time ? new Date(log.trigger_time).getTime() : Date.now(),
        logId: log.id,
        fromLineNum: Math.max(Number(q.fromLineNum ?? 1), 1),
      },
      group,
      config.trigger.rpcTimeoutSec,
    );
    if (!res || res.code !== 200) {
      return reply.send(ok({ fromLineNum: 1, toLineNum: 1, logContent: '日志读取失败：执行器不可达', isEnd: true }));
    }
    return reply.send(ok(res.data));
  });

  /** 终止运行中的任务 */
  app.post('/api/logs/:id/kill', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const { id } = req.params as { id: string };
    const log = await jobLogDao.load(Number(id));
    if (!log) return reply.code(404).send({ code: 500, msg: '日志不存在' });
    if (!hasGroupPermission(user, log.job_group)) return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    if (!log.executor_address) return reply.code(400).send({ code: 500, msg: '该执行未调度到执行器' });
    const group = await jobGroupDao.load(log.job_group);
    if (!group) return reply.code(404).send({ code: 500, msg: '执行器组不存在' });
    const res = await postJson(`${log.executor_address.replace(/\/+$/, '')}/kill`, { jobId: log.job_id }, group, config.trigger.rpcTimeoutSec);
    if (!res || res.code !== 200) {
      return reply.code(500).send({ code: 500, msg: '终止失败：执行器不可达' });
    }
    return reply.send(ok());
  });

  // ==================== reports & dashboard ====================

  app.get('/api/reports', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const days = Math.min(Number(q.days ?? 3), 30);
    const rows = await jobLogReportDao.listRecent(days);
    return ok(rows);
  });

  app.get('/api/dashboard', async () => {
    const jobs = await jobInfoDao.pageList({ start: 0, length: 100_000 });
    const runningJobs = jobs.rows.filter((j) => j.trigger_status === 1).length;
    const groups = await jobGroupDao.listAll();
    const onlineGroups = groups.filter((g) => g.registryList().length > 0).length;
    const today = new Date().toISOString().slice(0, 10);
    const todayAgg = await jobLogReportDao.aggregate(today);
    return ok({
      jobCount: jobs.total,
      runningJobs,
      groupCount: groups.length,
      onlineGroups,
      today: todayAgg,
    });
  });

  // ==================== 元数据（前端下拉） ====================

  app.get('/api/meta', async () => {
    return ok({
      routeStrategies: ROUTE_STRATEGIES,
      blockStrategies: ['SERIAL_EXECUTION', 'DISCARD_LATER', 'COVER_EARLY'],
      glueTypes: ['BEAN', 'GLUE_SHELL', 'GLUE_PYTHON', 'GLUE_NODEJS', 'GLUE_POWERSHELL'],
      misfireStrategies: ['DO_NOTHING', 'FIRE_ONCE_NOW'],
      scheduleTypes: ['NONE', 'CRON', 'FIX_RATE'],
    });
  });

  return { app, registryHelper, completeHelper, alarmHelper, logReportHelper };
}

export type { Response };
