import 'node:process';
import dotenv from 'dotenv';

dotenv.config();

function intOf(name: string, def: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

export const config = {
  server: {
    port: intOf('XXL_JOB_ADMIN_PORT', 8989),
    host: process.env.XXL_JOB_ADMIN_HOST ?? '0.0.0.0',
  },
  db: {
    host: process.env.XXL_JOB_DB_HOST ?? '127.0.0.1',
    port: intOf('XXL_JOB_DB_PORT', 3306),
    user: process.env.XXL_JOB_DB_USER ?? 'root',
    password: process.env.XXL_JOB_DB_PASSWORD ?? '',
    database: process.env.XXL_JOB_DB_NAME ?? 'xxl_job',
    connectionLimit: intOf('XXL_JOB_DB_POOL', 20),
    /** 集群行锁等待（秒） */
    lockWaitTimeout: intOf('XXL_JOB_DB_LOCK_WAIT', 30),
  },
  trigger: {
    fastMax: intOf('XXL_JOB_TRIGGERPOOL_FAST_MAX', 300),
    slowMax: intOf('XXL_JOB_TRIGGERPOOL_SLOW_MAX', 200),
    /** 单次调度扫描预读条数 */
    preReadCount: intOf('XXL_JOB_SCHEDULE_PREREAD', 5000),
    /** 调度回写批大小 */
    batchUpdateSize: 100,
    /** 触发 RPC 超时（秒） */
    rpcTimeoutSec: intOf('XXL_JOB_RPC_TIMEOUT', 3),
  },
  logRetentionDays: intOf('XXL_JOB_LOG_RETENTION_DAYS', 30),
};
