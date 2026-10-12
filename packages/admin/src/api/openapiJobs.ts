import type { FastifyInstance } from 'fastify';
import type { XxlJobInfo } from '../db/entities.js';
import { jobInfoDao, jobGroupDao } from '../dao/index.js';
import { jobService, type JobPayload } from '../service/JobService.js';
import { trigger, TriggerTypeEnum } from '../scheduler/JobTrigger.js';
import { groupCache } from '../scheduler/helpers.js';
import { TokenBucket } from './TokenBucket.js';
import { HEADER_ACCESS_TOKEN, HEADER_APPNAME } from '@xxl-job-node/core';
import type { XxlJobGroup } from '../db/entities.js';

/** 请求体键名归一化：兼容 Java 版 AdminJobBiz 的驼峰 DTO 与内部下划线字段 */
function snakeKeys(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    out[k.replace(/([A-Z])/g, '_$1').toLowerCase()] = v;
  }
  return out;
}

/** 对齐 Java 版 AdminJobBiz 的任务管理开放 API（第三方系统调用），令牌桶限流。 */
export function registerOpenapiJobRoutes(app: FastifyInstance): void {
  const bucket = new TokenBucket(100, 30_000);

  // 双 Header 鉴权：appname → 组缓存反查，token 必须匹配组级 accessToken
  const auth = (req: { headers: Record<string, unknown> }): XxlJobGroup | null => {
    const appname = String(req.headers[HEADER_APPNAME.toLowerCase()] ?? '');
    const token = String(req.headers[HEADER_ACCESS_TOKEN.toLowerCase()] ?? '');
    if (!appname || !token) return null;
    const group = groupCache.byAppnameOf(appname);
    if (!group || group.access_token !== token) return null;
    return group;
  };

  const limited = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean => {
    if (bucket.tryAcquire()) return false;
    reply.code(502).send({ code: 500, msg: 'openapi rate limit exceeded (100 calls / 30s)' });
    return true;
  };

  /** 请求体允许用 appname 或 jobGroup(id) 定位执行器组 */
  const resolveGroupId = async (body: object): Promise<number | null> => {
    const b = body as { jobGroup?: unknown; appname?: unknown };
    if (typeof b.jobGroup === 'number' && b.jobGroup > 0) return b.jobGroup;
    if (typeof b.appname === 'string' && b.appname) {
      const group = await jobGroupDao.loadByAppname(b.appname);
      return group?.id ?? null;
    }
    return null;
  };

  app.post('/api/addJob', async (req, reply) => {
    if (!auth(req)) return reply.code(401).send({ code: 500, msg: 'The access token or appname is incorrect.' });
    if (limited(reply)) return reply;
    const raw = snakeKeys((req.body ?? {}) as Record<string, unknown>);
    const body = raw as JobPayload & { appname?: string };
    const groupId = await resolveGroupId(raw);
    if (!groupId) return reply.code(400).send({ code: 500, msg: 'jobGroup 或 appname 无效' });
    const payload: JobPayload = { ...body, job_group: groupId };
    const error = jobService.validate(payload);
    if (error) return reply.code(400).send({ code: 500, msg: error });
    const id = await jobService.add(payload);
    return reply.send({ code: 200, msg: 'success', data: { id } });
  });

  app.post('/api/updateJob', async (req, reply) => {
    if (!auth(req)) return reply.code(401).send({ code: 500, msg: 'The access token or appname is incorrect.' });
    if (limited(reply)) return reply;
    const raw = snakeKeys((req.body ?? {}) as Record<string, unknown>);
    const body = raw as JobPayload;
    if (!body.id) return reply.code(400).send({ code: 500, msg: 'id 必填' });
    const exists = await jobInfoDao.load(body.id);
    if (!exists) return reply.code(404).send({ code: 500, msg: '任务不存在' });
    const groupId = await resolveGroupId(raw);
    const payload: JobPayload = { ...body, job_group: groupId ?? exists.job_group };
    const error = jobService.validate(payload);
    if (error) return reply.code(400).send({ code: 500, msg: error });
    await jobService.update(payload);
    return reply.send({ code: 200, msg: 'success' });
  });

  app.post('/api/removeJob', async (req, reply) => {
    if (!auth(req)) return reply.code(401).send({ code: 500, msg: 'The access token or appname is incorrect.' });
    if (limited(reply)) return reply;
    const { id } = (req.body ?? {}) as { id?: number };
    if (!id) return reply.code(400).send({ code: 500, msg: 'id 必填' });
    try {
      await jobService.remove(id);
      return reply.send({ code: 200, msg: 'success' });
    } catch (e) {
      return reply.code(400).send({ code: 500, msg: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/api/startJob', async (req, reply) => {
    if (!auth(req)) return reply.code(401).send({ code: 500, msg: 'The access token or appname is incorrect.' });
    if (limited(reply)) return reply;
    const { id } = (req.body ?? {}) as { id?: number };
    if (!id) return reply.code(400).send({ code: 500, msg: 'id 必填' });
    try {
      await jobService.start(id);
      return reply.send({ code: 200, msg: 'success' });
    } catch (e) {
      return reply.code(400).send({ code: 500, msg: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/api/stopJob', async (req, reply) => {
    if (!auth(req)) return reply.code(401).send({ code: 500, msg: 'The access token or appname is incorrect.' });
    if (limited(reply)) return reply;
    const { id } = (req.body ?? {}) as { id?: number };
    if (!id) return reply.code(400).send({ code: 500, msg: 'id 必填' });
    try {
      await jobService.stop(id);
      return reply.send({ code: 200, msg: 'success' });
    } catch (e) {
      return reply.code(400).send({ code: 500, msg: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/api/triggerJob', async (req, reply) => {
    if (!auth(req)) return reply.code(401).send({ code: 500, msg: 'The access token or appname is incorrect.' });
    if (limited(reply)) return reply;
    const { id, executorParam, addressList } = (req.body ?? {}) as {
      id?: number;
      executorParam?: string;
      addressList?: string;
    };
    if (!id) return reply.code(400).send({ code: 500, msg: 'id 必填' });
    const job = await jobInfoDao.load(id);
    if (!job) return reply.code(404).send({ code: 500, msg: '任务不存在' });
    await trigger(id, {
      triggerType: TriggerTypeEnum.MANUAL,
      executorParam: executorParam ?? null,
      addressList: addressList ?? null,
    });
    return reply.send({ code: 200, msg: 'success' });
  });
}

export type { XxlJobInfo };
