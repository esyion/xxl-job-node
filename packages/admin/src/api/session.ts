import type { FastifyReply, FastifyRequest } from 'fastify';
import type { XxlJobUser } from '../db/entities.js';

const SESSION_COOKIE = 'xxl_job_session';

export interface SessionUser {
  userId: number;
  username: string;
  role: number;
  permission: string | null;
}

/** 内存会话表（admin 实例内），生产多实例时粘性路由或换 Redis 存储 */
export const sessions = new Map<string, SessionUser>();

export function getCookieToken(req: FastifyRequest): string | undefined {
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return v.join('=');
  }
  return undefined;
}

export function getSessionUser(req: FastifyRequest): SessionUser | undefined {
  const token = getCookieToken(req);
  return token ? sessions.get(token) : undefined;
}

export function requireSession(req: FastifyRequest, reply: FastifyReply): SessionUser | null {
  const user = getSessionUser(req);
  if (!user) {
    reply.code(401).send({ code: 500, msg: '未登录或会话已过期' });
    return null;
  }
  return user;
}

/**
 * 数据权限：普通用户（role=0）可见的执行器组 ID 列表；
 * 管理员（role=1）或未配置权限返回 null 表示不限制。
 */
export function visibleGroupIds(user: SessionUser): number[] | null {
  if (user.role === 1) return null;
  const ids = (user.permission ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : [];
}

export function hasGroupPermission(user: SessionUser, groupId: number): boolean {
  const visible = visibleGroupIds(user);
  return visible === null || visible.includes(groupId);
}

export function toSafeUser(user: XxlJobUser): Omit<XxlJobUser, 'password' | 'token'> {
  const { password: _password, token: _token, ...rest } = user;
  void _password;
  void _token;
  return rest;
}
