import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { jobUserDao } from '../dao/index.js';
import { jobUserWriteDao } from '../dao/user.js';
import { requireSession, sessions, toSafeUser, getCookieToken } from './session.js';

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 用户管理（仅管理员）+ 个人改密 + 登出（登录在 app.ts） */
export function registerUserRoutes(app: FastifyInstance): void {
  const adminOnly = (user: { role: number }): boolean => user.role === 1;

  app.get('/api/users', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    if (!adminOnly(user)) return reply.code(403).send({ code: 500, msg: '仅管理员可管理用户' });
    const users = await jobUserDao.listAll();
    return reply.send({ code: 200, msg: 'success', data: users.map(toSafeUser) });
  });

  app.post('/api/users', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    if (!adminOnly(user)) return reply.code(403).send({ code: 500, msg: '仅管理员可管理用户' });
    const body = (req.body ?? {}) as { username?: string; password?: string; role?: number; permission?: string | null };
    if (!body.username?.trim()) return reply.code(400).send({ code: 500, msg: '请输入账号' });
    if (!body.password || body.password.length < 6) return reply.code(400).send({ code: 500, msg: '密码至少 6 位' });
    const exists = await jobUserDao.loadByUsername(body.username.trim());
    if (exists) return reply.code(400).send({ code: 500, msg: '账号已存在' });
    const id = await jobUserWriteDao.insert({
      username: body.username.trim(),
      password: sha256(body.password),
      role: body.role === 1 ? 1 : 0,
      permission: body.role === 1 ? null : (body.permission ?? ''),
    });
    return reply.send({ code: 200, msg: 'success', data: { id } });
  });

  app.put('/api/users/:id', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    if (!adminOnly(user)) return reply.code(403).send({ code: 500, msg: '仅管理员可管理用户' });
    const { id } = req.params as { id: string };
    const target = await jobUserDao.loadById(Number(id));
    if (!target) return reply.code(404).send({ code: 500, msg: '用户不存在' });
    const body = (req.body ?? {}) as { password?: string; role?: number; permission?: string | null };
    if (target.id === user.userId && body.role === 0) {
      return reply.code(400).send({ code: 500, msg: '不能降级自己的管理员角色' });
    }
    await jobUserWriteDao.update(target.id, {
      password: body.password && body.password.length >= 6 ? sha256(body.password) : undefined,
      role: body.role,
      permission: body.role === 1 ? null : body.permission,
    });
    // 权限变更同步到在线会话
    for (const s of sessions.values()) {
      if (s.userId === target.id) {
        s.role = body.role ?? s.role;
        s.permission = body.role === 1 ? null : (body.permission ?? s.permission);
      }
    }
    return reply.send({ code: 200, msg: 'success' });
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    if (!adminOnly(user)) return reply.code(403).send({ code: 500, msg: '仅管理员可管理用户' });
    const { id } = req.params as { id: string };
    const target = await jobUserDao.loadById(Number(id));
    if (!target) return reply.code(404).send({ code: 500, msg: '用户不存在' });
    if (target.id === user.userId) return reply.code(400).send({ code: 500, msg: '不能删除自己' });
    if (target.role === 1 && (await jobUserWriteDao.countAdmins()) <= 1) {
      return reply.code(400).send({ code: 500, msg: '系统至少保留一个管理员' });
    }
    await jobUserWriteDao.remove(target.id);
    for (const [token, s] of sessions) {
      if (s.userId === target.id) sessions.delete(token);
    }
    return reply.send({ code: 200, msg: 'success' });
  });

  // 个人修改密码（所有登录用户）
  app.post('/api/auth/change-password', async (req, reply) => {
    const user = requireSession(req, reply);
    if (!user) return reply;
    const body = (req.body ?? {}) as { oldPassword?: string; newPassword?: string };
    if (!body.oldPassword || !body.newPassword) return reply.code(400).send({ code: 500, msg: '请输入旧密码与新密码' });
    if (body.newPassword.length < 6) return reply.code(400).send({ code: 500, msg: '新密码至少 6 位' });
    const target = await jobUserDao.loadById(user.userId);
    if (!target || target.password !== sha256(body.oldPassword)) {
      return reply.code(400).send({ code: 500, msg: '旧密码错误' });
    }
    await jobUserWriteDao.update(user.userId, { password: sha256(body.newPassword) });
    return reply.send({ code: 200, msg: 'success' });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = getCookieToken(req);
    if (token) sessions.delete(token);
    reply.clearCookie('xxl_job_session', { path: '/' });
    return reply.send({ code: 200, msg: 'success' });
  });
}
