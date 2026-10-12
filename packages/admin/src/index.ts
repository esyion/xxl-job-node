import { config } from './config.js';
import { pool } from './db/pool.js';
import { buildApp } from './app.js';
import { ScheduleCore } from './scheduler/ScheduleCore.js';

async function main(): Promise<void> {
  // 0. 数据库连通性
  try {
    await pool.query('SELECT 1');
    console.log(`[xxl-job-admin] db connected: ${config.db.host}:${config.db.port}/${config.db.database}`);
  } catch (e) {
    console.error('[xxl-job-admin] db connect failed:', e instanceof Error ? e.message : e);
    console.error('请检查环境变量 XXL_JOB_DB_* 配置，并先执行 doc/db/tables_xxl_job.sql 初始化数据库。');
    process.exit(1);
  }

  // 1. Web API + 后台 Helper
  const { app, registryHelper, completeHelper, alarmHelper, logReportHelper } = await buildApp();
  await registryHelper.start();
  completeHelper.start();
  alarmHelper.start();
  logReportHelper.start();

  // 2. 调度内核（行锁 + 时间轮）
  const scheduleCore = new ScheduleCore();
  scheduleCore.start();

  // 3. HTTP 监听
  await app.listen({ port: config.server.port, host: config.server.host });
  console.log(`[xxl-job-admin] server listening on http://${config.server.host}:${config.server.port}`);

  // 4. 优雅停机
  const shutdown = async (signal: string) => {
    console.log(`[xxl-job-admin] received ${signal}, shutting down...`);
    await scheduleCore.stop();
    registryHelper.stop();
    completeHelper.stop();
    alarmHelper.stop();
    logReportHelper.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
