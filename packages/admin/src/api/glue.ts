import { formatDateTime } from '@xxl-job-node/core';
import type { FastifyInstance } from 'fastify';
import { jobInfoDao } from '../dao/index.js';
import { execute } from '../db/pool.js';
import { jobLogGlueDao } from '../dao/glue.js';
import { requireSession, hasGroupPermission } from './session.js';

/**
 * GLUE 源码版本管理：
 *  - 运行中的 GLUE 任务也允许更新源码（执行器按 glueUpdatetime 缓存脚本文件，热更新自动生效）
 *  - 每次保存插入一条版本记录（保留最近 50 条），支持查看历史与回滚
 */
export function registerGlueRoutes(app: FastifyInstance): void {
  // 版本列表
  app.get('/api/jobs/:id/glue', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const { id } = req.params as { id: string };
    const job = await jobInfoDao.load(Number(id));
    if (!job) return reply.code(404).send({ code: 500, msg: '任务不存在' });
    if (!hasGroupPermission(user, job.job_group)) return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    const versions = await jobLogGlueDao.listByJobId(job.id);
    return reply.send({ code: 200, msg: 'success', data: versions });
  });

  // 保存/更新源码（含回滚：前端取版本内容后调同一接口）
  app.put('/api/jobs/:id/glue', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { glueSource?: string; glueRemark?: string };
    const job = await jobInfoDao.load(Number(id));
    if (!job) return reply.code(404).send({ code: 500, msg: '任务不存在' });
    if (!hasGroupPermission(user, job.job_group)) return reply.code(403).send({ code: 500, msg: '无该执行器组权限' });
    if (job.glue_type === 'BEAN') return reply.code(400).send({ code: 500, msg: 'BEAN 任务无 GLUE 源码' });
    const glueSource = (body.glueSource ?? '').trim();
    if (!glueSource) return reply.code(400).send({ code: 500, msg: '请输入脚本源码' });
    const glueRemark = (body.glueRemark ?? '').trim() || `版本 ${formatDateTime(new Date())}`;

    // 更新任务当前源码 + glueUpdatetime（执行器据此后缀缓存失效）
    await execute(
      'UPDATE xxl_job_info SET glue_source = ?, glue_remark = ?, glue_updatetime = now(), update_time = now() WHERE id = ?',
      [glueSource, glueRemark, job.id],
    );
    // 插入版本记录
    await jobLogGlueDao.save(job.id, job.glue_type, glueSource, glueRemark);
    return reply.send({ code: 200, msg: 'success' });
  });
}
