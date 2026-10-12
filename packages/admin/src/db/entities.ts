/** 数据库实体类型（与 doc/db/tables_xxl_job.sql 一一对应） */

export interface XxlJobGroup {
  id: number;
  app_name: string;
  name: string;
  address_type: number;
  address_list: string | null;
  access_token: string | null;
  update_time: string | null;

  /** address_list 逗号拆分 */
  registryList(): string[];
}

export interface XxlJobInfo {
  id: number;
  job_group: number;
  name: string;
  author: string | null;
  alarm_email: string | null;
  schedule_type: 'NONE' | 'CRON' | 'FIX_RATE';
  schedule_conf: string | null;
  misfire_strategy: 'DO_NOTHING' | 'FIRE_ONCE_NOW';
  executor_route_strategy: string | null;
  executor_handler: string | null;
  executor_param: string | null;
  executor_block_strategy: 'SERIAL_EXECUTION' | 'DISCARD_LATER' | 'COVER_EARLY';
  executor_timeout: number;
  executor_fail_retry_count: number;
  glue_type: string;
  glue_source: string | null;
  glue_remark: string | null;
  glue_updatetime: string | null;
  child_jobid: string | null;
  trigger_status: number;
  trigger_last_time: number;
  trigger_next_time: number;
  add_time: string | null;
  update_time: string | null;
}

export interface XxlJobLog {
  id: number;
  job_group: number;
  job_id: number;
  executor_address: string | null;
  executor_handler: string | null;
  executor_param: string | null;
  executor_sharding_param: string | null;
  executor_fail_retry_count: number;
  trigger_time: string | null;
  trigger_code: number;
  trigger_msg: string | null;
  handle_time: string | null;
  handle_code: number;
  handle_msg: string | null;
  alarm_status: number;
}

export interface XxlJobRegistry {
  id: number;
  registry_group: string;
  registry_key: string;
  registry_value: string;
  update_time: string | null;
}

export interface XxlJobUser {
  id: number;
  username: string;
  password: string;
  token: string | null;
  role: number;
  permission: string | null;
}

export interface XxlJobLogReport {
  id: number;
  trigger_day: string | null;
  running_count: number;
  suc_count: number;
  fail_count: number;
  update_time: string | null;
}
