import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import type { XxlJobInfo, XxlJobLog, XxlJobGroup, XxlJobRegistry, XxlJobUser, XxlJobLogReport } from '../db/entities.js';
import { pool, query, execute } from '../db/pool.js';
import { config } from '../config.js';

// ==================== xxl_job_lock ====================

export const lockDao = {
  /** 集群调度互斥：事务内行锁，持锁期 = 扫描+回写 */
  async scheduleLock(conn: PoolConnection): Promise<void> {
    await conn.query("SELECT * FROM xxl_job_lock WHERE lock_name = 'schedule_lock' FOR UPDATE");
  },
};

// ==================== xxl_job_info ====================

export interface ScheduleUpdate {
  id: number;
  trigger_last_time: number;
  trigger_next_time: number;
  /** -1 = 不改变状态（本轮刷新 next 后维持原值） */
  trigger_status: number;
}

export const jobInfoDao = {
  async load(id: number): Promise<XxlJobInfo | null> {
    const rows = await query<XxlJobInfo>('SELECT * FROM xxl_job_info WHERE id = ?', [id]);
    return rows[0] ?? null;
  },

  async pageList(opts: {
    jobGroup?: number;
    groupIds?: number[] | null;
    executorHandler?: string;
    name?: string;
    triggerStatus?: number;
    start: number;
    length: number;
  }): Promise<{ total: number; rows: XxlJobInfo[] }> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (opts.jobGroup && opts.jobGroup > 0) {
      where.push('job_group = ?');
      params.push(opts.jobGroup);
    } else if (opts.groupIds) {
      if (opts.groupIds.length === 0) return { total: 0, rows: [] };
      where.push(`job_group IN (${opts.groupIds.join(',')})`);
    }
    if (opts.executorHandler) {
      where.push('executor_handler LIKE ?');
      params.push(`%${opts.executorHandler}%`);
    }
    if (opts.name) {
      where.push('name LIKE ?');
      params.push(`%${opts.name}%`);
    }
    if (opts.triggerStatus !== undefined && opts.triggerStatus >= 0) {
      where.push('trigger_status = ?');
      params.push(opts.triggerStatus);
    }
    const whereSql = where.join(' AND ');
    const totalRows = await query<{ c: number }>(`SELECT COUNT(1) AS c FROM xxl_job_info WHERE ${whereSql}`, params);
    const rows = await query<XxlJobInfo>(
      `SELECT * FROM xxl_job_info WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, opts.length, opts.start],
    );
    return { total: Number(totalRows[0]?.c ?? 0), rows };
  },

  async insert(job: Partial<XxlJobInfo>): Promise<number> {
    const r = await execute(
      `INSERT INTO xxl_job_info(job_group, name, author, alarm_email, schedule_type, schedule_conf, misfire_strategy,
        executor_route_strategy, executor_handler, executor_param, executor_block_strategy, executor_timeout,
        executor_fail_retry_count, glue_type, glue_source, glue_remark, glue_updatetime, child_jobid,
        trigger_status, trigger_last_time, trigger_next_time, add_time, update_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,now(),now())`,
      [
        job.job_group, job.name, job.author ?? '', job.alarm_email ?? '',
        job.schedule_type ?? 'NONE', job.schedule_conf ?? '', job.misfire_strategy ?? 'DO_NOTHING',
        job.executor_route_strategy ?? 'FIRST', job.executor_handler ?? '', job.executor_param ?? '',
        job.executor_block_strategy ?? 'SERIAL_EXECUTION', job.executor_timeout ?? 0,
        job.executor_fail_retry_count ?? 0, job.glue_type ?? 'BEAN', job.glue_source ?? '',
        job.glue_remark ?? '', job.glue_updatetime ?? null, job.child_jobid ?? '',
      ],
    );
    return (r as ResultSetHeader).insertId;
  },

  async update(job: XxlJobInfo): Promise<void> {
    await execute(
      `UPDATE xxl_job_info SET job_group=?, name=?, author=?, alarm_email=?, schedule_type=?, schedule_conf=?,
        misfire_strategy=?, executor_route_strategy=?, executor_handler=?, executor_param=?,
        executor_block_strategy=?, executor_timeout=?, executor_fail_retry_count=?, glue_type=?, glue_source=?,
        glue_remark=?, glue_updatetime=?, child_jobid=? WHERE id=?`,
      [
        job.job_group, job.name, job.author, job.alarm_email, job.schedule_type, job.schedule_conf,
        job.misfire_strategy, job.executor_route_strategy, job.executor_handler, job.executor_param,
        job.executor_block_strategy, job.executor_timeout, job.executor_fail_retry_count, job.glue_type,
        job.glue_source, job.glue_remark, job.glue_updatetime, job.child_jobid, job.id,
      ],
    );
  },

  async remove(id: number): Promise<void> {
    await execute('DELETE FROM xxl_job_info WHERE id = ?', [id]);
    await execute('DELETE FROM xxl_job_logglue WHERE job_id = ?', [id]);
  },

  async updateStatus(id: number, status: number, lastTime: number, nextTime: number): Promise<void> {
    await execute(
      'UPDATE xxl_job_info SET trigger_status = ?, trigger_last_time = ?, trigger_next_time = ?, update_time = now() WHERE id = ?',
      [status, lastTime, nextTime, id],
    );
  },

  /** 调度扫描：未来 5 秒内到期的运行中任务 */
  async scheduleQuery(conn: PoolConnection, maxNextTime: number, limit: number): Promise<XxlJobInfo[]> {
    const [rows] = await conn.query(
      'SELECT * FROM xxl_job_info WHERE trigger_status = 1 AND trigger_next_time <= ? ORDER BY id ASC LIMIT ?',
      [maxNextTime, limit],
    );
    return rows as unknown as XxlJobInfo[];
  },

  /** 批量回写调度游标（CASE WHEN 一次更新多行，乐观条件 trigger_status=1） */
  async scheduleBatchUpdate(conn: PoolConnection, updates: ScheduleUpdate[]): Promise<void> {
    const size = config.trigger.batchUpdateSize;
    for (let i = 0; i < updates.length; i += size) {
      const batch = updates.slice(i, i + size);
      const ids = batch.map((u) => u.id);
      const lastCase = batch.map((u) => `WHEN ${u.id} THEN ${u.trigger_last_time}`).join(' ');
      const nextCase = batch.map((u) => `WHEN ${u.id} THEN ${u.trigger_next_time}`).join(' ');
      const statusCase = batch.map((u) => `WHEN ${u.id} THEN ${u.trigger_status}`).join(' ');
      await conn.query(
        `UPDATE xxl_job_info SET
           trigger_last_time = CASE id ${lastCase} END,
           trigger_next_time = CASE id ${nextCase} END,
           trigger_status = CASE id ${statusCase} END
         WHERE id IN (${ids.join(',')}) AND trigger_status = 1`,
      );
    }
  },
};


// ==================== xxl_job_log ====================

export const jobLogDao = {
  async addTriggerLog(log: {
    job_group: number;
    job_id: number;
    executor_address: string | null;
    executor_handler: string | null;
    executor_param: string | null;
    executor_sharding_param: string | null;
    executor_fail_retry_count: number;
    trigger_time: string;
  }): Promise<number> {
    const r = await execute(
      `INSERT INTO xxl_job_log(job_group, job_id, executor_address, executor_handler, executor_param,
        executor_sharding_param, executor_fail_retry_count, trigger_time, trigger_code, handle_code)
       VALUES (?,?,?,?,?,?,?,?,200,0)`,
      [
        log.job_group, log.job_id, log.executor_address, log.executor_handler, log.executor_param,
        log.executor_sharding_param, log.executor_fail_retry_count, log.trigger_time,
      ],
    );
    return (r as ResultSetHeader).insertId;
  },

  async updateTriggerInfo(
    id: number,
    code: number,
    msg: string,
    address: string | null,
    handler: string | null,
    param: string | null,
    shardingParam: string | null,
    retryCount: number,
  ): Promise<void> {
    await execute(
      `UPDATE xxl_job_log SET trigger_code = ?, trigger_msg = ?, executor_address = ?, executor_handler = ?,
        executor_param = ?, executor_sharding_param = ?, executor_fail_retry_count = ? WHERE id = ?`,
      [code, msg.slice(0, 8000), address, handler, param, shardingParam, retryCount, id],
    );
  },

  async updateHandleInfo(id: number, code: number, msg: string, alarmStatus?: number): Promise<void> {
    if (alarmStatus !== undefined) {
      await execute(
        'UPDATE xxl_job_log SET handle_time = now(), handle_code = ?, handle_msg = ?, alarm_status = ? WHERE id = ?',
        [code, msg.slice(0, 15000), alarmStatus, id],
      );
    } else {
      await execute(
        'UPDATE xxl_job_log SET handle_time = now(), handle_code = ?, handle_msg = ? WHERE id = ?',
        [code, msg.slice(0, 15000), id],
      );
    }
  },

  async load(id: number): Promise<XxlJobLog | null> {
    const rows = await query<XxlJobLog>('SELECT * FROM xxl_job_log WHERE id = ?', [id]);
    return rows[0] ?? null;
  },

  async pageList(opts: {
    jobGroup?: number;
    groupIds?: number[] | null;
    jobId?: number;
    logStatus?: number; // 1=成功 2=失败 3=进行中
    filterTime?: [string, string];
    start: number;
    length: number;
  }): Promise<{ total: number; rows: XxlJobLog[] }> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (opts.jobGroup && opts.jobGroup > 0) {
      where.push('job_group = ?');
      params.push(opts.jobGroup);
    } else if (opts.groupIds) {
      if (opts.groupIds.length === 0) return { total: 0, rows: [] };
      where.push(`job_group IN (${opts.groupIds.join(',')})`);
    }
    if (opts.jobId && opts.jobId > 0) {
      where.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.filterTime) {
      where.push('trigger_time BETWEEN ? AND ?');
      params.push(opts.filterTime[0], opts.filterTime[1]);
    }
    if (opts.logStatus === 1) {
      where.push('handle_code = 200');
    } else if (opts.logStatus === 2) {
      where.push('(handle_code NOT IN (0, 200) OR trigger_code NOT IN (0, 200))');
    } else if (opts.logStatus === 3) {
      where.push('trigger_code = 200 AND handle_code = 0');
    }
    const whereSql = where.join(' AND ');
    const totalRows = await query<{ c: number }>(`SELECT COUNT(1) AS c FROM xxl_job_log WHERE ${whereSql}`, params);
    const rows = await query<XxlJobLog>(
      `SELECT * FROM xxl_job_log WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, opts.length, opts.start],
    );
    return { total: Number(totalRows[0]?.c ?? 0), rows };
  },

  async pageListCount(opts: { jobGroup?: number; jobId?: number; logStatus?: number; filterTime?: [string, string] }): Promise<number> {
    const r = await jobLogDao.pageList({ ...opts, start: 0, length: 1 });
    return r.total;
  },

  /** 回调处理中查重 */
  async findLostJobIds(deadLine: string, limit: number): Promise<number[]> {
    const rows = await query<{ id: number }>(
      `SELECT t.id FROM xxl_job_log t LEFT JOIN xxl_job_registry r ON t.executor_address = r.registry_value
       WHERE t.trigger_code = 200 AND t.handle_code = 0 AND t.trigger_time <= ?
         AND r.id IS NULL
       ORDER BY t.id ASC LIMIT ?`,
      [deadLine, limit],
    );
    return rows.map((r) => r.id);
  },

  async findFailJobLogIds(limit: number): Promise<number[]> {
    const rows = await query<{ id: number }>(
      `SELECT id FROM xxl_job_log WHERE alarm_status = 0
         AND (handle_code NOT IN (0, 200) OR trigger_code NOT IN (0, 200))
       ORDER BY id ASC LIMIT ?`,
      [limit],
    );
    return rows.map((r) => r.id);
  },

  /** CAS 抢告警锁：0 → -1 */
  async casAlarmStatus(id: number, oldStatus: number, newStatus: number): Promise<boolean> {
    const r = await execute('UPDATE xxl_job_log SET alarm_status = ? WHERE id = ? AND alarm_status = ?', [
      newStatus, id, oldStatus,
    ]);
    return (r as ResultSetHeader).affectedRows > 0;
  },

  async clearLog(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await execute(`DELETE FROM xxl_job_log WHERE id IN (${ids.join(',')})`);
  },

  async findClearLogIds(jobIds: number[], beforeTime: string, limit: number): Promise<number[]> {
    if (!jobIds.length) return [];
    const rows = await query<{ id: number }>(
      `SELECT id FROM xxl_job_log WHERE job_id IN (${jobIds.join(',')}) AND trigger_time <= ? ORDER BY id LIMIT ?`,
      [beforeTime, limit],
    );
    return rows.map((r) => r.id);
  },
};

// ==================== xxl_job_group / registry / user / report ====================

export const jobGroupDao = {
  async load(id: number): Promise<XxlJobGroup | null> {
    const rows = await query<XxlJobGroup>('SELECT * FROM xxl_job_group WHERE id = ?', [id]);
    return rows[0] ? withRegistryList(rows[0]) : null;
  },
  async loadByAppname(appname: string): Promise<XxlJobGroup | null> {
    const rows = await query<XxlJobGroup>('SELECT * FROM xxl_job_group WHERE app_name = ?', [appname]);
    return rows[0] ? withRegistryList(rows[0]) : null;
  },
  async listAll(): Promise<XxlJobGroup[]> {
    const rows = await query<XxlJobGroup>('SELECT * FROM xxl_job_group ORDER BY id ASC');
    return rows.map(withRegistryList);
  },
  async pageList(opts: { appname?: string; name?: string; start: number; length: number }): Promise<{ total: number; rows: XxlJobGroup[] }> {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (opts.appname) {
      where.push('app_name LIKE ?');
      params.push(`%${opts.appname}%`);
    }
    if (opts.name) {
      where.push('name LIKE ?');
      params.push(`%${opts.name}%`);
    }
    const whereSql = where.join(' AND ');
    const totalRows = await query<{ c: number }>(`SELECT COUNT(1) AS c FROM xxl_job_group WHERE ${whereSql}`, params);
    const rows = await query<XxlJobGroup>(
      `SELECT * FROM xxl_job_group WHERE ${whereSql} ORDER BY id ASC LIMIT ? OFFSET ?`,
      [...params, opts.length, opts.start],
    );
    return { total: Number(totalRows[0]?.c ?? 0), rows: rows.map(withRegistryList) };
  },
  async insert(group: { app_name: string; name: string; address_type: number; address_list: string; access_token: string }): Promise<number> {
    const r = await execute(
      'INSERT INTO xxl_job_group(app_name, name, address_type, address_list, access_token, update_time) VALUES (?,?,?,?,?,now())',
      [group.app_name, group.name, group.address_type, group.address_list, group.access_token],
    );
    return (r as ResultSetHeader).insertId;
  },
  async update(group: XxlJobGroup): Promise<void> {
    await execute(
      'UPDATE xxl_job_group SET app_name=?, name=?, address_type=?, address_list=?, access_token=?, update_time=now() WHERE id=?',
      [group.app_name, group.name, group.address_type, group.address_list ?? '', group.access_token, group.id],
    );
  },
  async remove(id: number): Promise<void> {
    await execute('DELETE FROM xxl_job_group WHERE id = ?', [id]);
  },
  /** 注册聚合回写（仅自动注册组） */
  async updateAddressList(appname: string, addressList: string): Promise<void> {
    await execute(
      'UPDATE xxl_job_group SET address_list = ?, update_time = now() WHERE app_name = ? AND address_type = 0',
      [addressList, appname],
    );
  },
};

export const jobRegistryDao = {
  async saveOrUpdate(registryGroup: string, registryKey: string, registryValue: string): Promise<void> {
    await execute(
      `INSERT INTO xxl_job_registry(registry_group, registry_key, registry_value, update_time)
       VALUES (?,?,?,now()) ON DUPLICATE KEY UPDATE update_time = now()`,
      [registryGroup, registryKey, registryValue],
    );
  },
  async remove(registryGroup: string, registryKey: string, registryValue: string): Promise<void> {
    await execute(
      'DELETE FROM xxl_job_registry WHERE registry_group = ? AND registry_key = ? AND registry_value = ?',
      [registryGroup, registryKey, registryValue],
    );
  },
  async removeDead(timeoutSec: number): Promise<number> {
    const r = await execute(
      "DELETE FROM xxl_job_registry WHERE update_time < DATE_ADD(NOW(), INTERVAL ? SECOND)",
      [-timeoutSec],
    );
    return (r as ResultSetHeader).affectedRows;
  },
  async findAll(): Promise<XxlJobRegistry[]> {
    return query<XxlJobRegistry>('SELECT * FROM xxl_job_registry WHERE update_time > DATE_ADD(NOW(), INTERVAL -90 SECOND)');
  },
};

export const jobUserDao = {
  async loadByUsername(username: string): Promise<XxlJobUser | null> {
    const rows = await query<XxlJobUser>('SELECT * FROM xxl_job_user WHERE username = ?', [username]);
    return rows[0] ?? null;
  },
  async loadById(id: number): Promise<XxlJobUser | null> {
    const rows = await query<XxlJobUser>('SELECT * FROM xxl_job_user WHERE id = ?', [id]);
    return rows[0] ?? null;
  },
  async listAll(): Promise<XxlJobUser[]> {
    return query<XxlJobUser>('SELECT * FROM xxl_job_user ORDER BY id ASC');
  },
};

export const jobLogReportDao = {
  async saveOrUpdate(day: string, running: number, suc: number, fail: number): Promise<void> {
    await execute(
      `INSERT INTO xxl_job_log_report(trigger_day, running_count, suc_count, fail_count, update_time)
       VALUES (?,?,?,?,now()) ON DUPLICATE KEY UPDATE
         running_count = VALUES(running_count), suc_count = VALUES(suc_count),
         fail_count = VALUES(fail_count), update_time = now()`,
      [day, running, suc, fail],
    );
  },
  async listRecent(days: number): Promise<XxlJobLogReport[]> {
    return query<XxlJobLogReport>(
      'SELECT * FROM xxl_job_log_report WHERE trigger_day >= DATE_ADD(NOW(), INTERVAL -? DAY) ORDER BY trigger_day ASC',
      [days],
    );
  },
  async aggregate(day: string): Promise<{ running: number; suc: number; fail: number }> {
    const rows = await query<{ running: number; suc: number; fail: number }>(
      `SELECT
         SUM(CASE WHEN trigger_code IN (0, 200) AND handle_code = 0 THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN handle_code = 200 THEN 1 ELSE 0 END) AS suc,
         SUM(CASE WHEN handle_code NOT IN (0, 200) OR trigger_code NOT IN (0, 200) THEN 1 ELSE 0 END) AS fail
       FROM xxl_job_log WHERE trigger_time BETWEEN ? AND ?`,
      [`${day} 00:00:00`, `${day} 23:59:59`],
    );
    return {
      running: Number(rows[0]?.running ?? 0),
      suc: Number(rows[0]?.suc ?? 0),
      fail: Number(rows[0]?.fail ?? 0),
    };
  },
};

// ==================== helpers ====================

function withRegistryList(g: XxlJobGroup): XxlJobGroup {
  g.registryList = () =>
    (g.address_list ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return g;
}

export async function healthyCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

