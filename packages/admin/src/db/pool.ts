import mysql from 'mysql2/promise';
import type { Pool, PoolConnection } from 'mysql2/promise';
import { config } from '../config.js';

export const pool: Pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: config.db.connectionLimit,
  waitForConnections: true,
  namedPlaceholders: false,
  charset: 'utf8mb4',
  dateStrings: true,
  supportBigNumbers: true,
});

// 每个新建连接都设置行锁等待超时（SET SESSION 只对单连接生效，必须挂在池的建连事件上）
// 注意：connection 事件给的是回调式连接，须用回调签名
pool.on('connection', (conn: { query: (sql: string, params: unknown[], cb: (err: unknown) => void) => void }) => {
  conn.query('SET SESSION innodb_lock_wait_timeout = ?', [config.db.lockWaitTimeout], () => undefined);
});

/**
 * 手动事务：整个回调期间独占同一连接（调度行锁的正确性依赖于此）。
 */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback().catch(() => undefined);
    throw e;
  } finally {
    conn.release();
  }
}

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function execute(sql: string, params: unknown[] = []): Promise<mysql.ResultSetHeader> {
  const [result] = await pool.query(sql, params);
  return result as mysql.ResultSetHeader;
}
