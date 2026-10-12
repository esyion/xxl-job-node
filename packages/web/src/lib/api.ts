/** 统一 API 客户端：cookie 会话 + 统一响应结构 */

export interface ApiEnvelope<T> {
  code: number;
  msg: string;
  data?: T;
}

export async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    window.location.hash = '#/login';
    throw new Error('未登录或会话已过期');
  }
  const json = (await res.json()) as ApiEnvelope<T>;
  if (json.code !== 200) throw new Error(json.msg || '请求失败');
  return json.data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const put = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

// ==================== 实体类型（镜像后端 DB 字段） ====================

export interface JobGroup {
  id: number;
  app_name: string;
  name: string;
  address_type: number;
  address_list: string | null;
  access_token: string | null;
  update_time: string | null;
  registryList?: () => string[];
}

export interface JobInfo {
  id: number;
  job_group: number;
  name: string;
  author: string | null;
  alarm_email: string | null;
  schedule_type: 'NONE' | 'CRON' | 'FIX_RATE';
  schedule_conf: string | null;
  misfire_strategy: string;
  executor_route_strategy: string;
  executor_handler: string | null;
  executor_param: string | null;
  executor_block_strategy: string;
  executor_timeout: number;
  executor_fail_retry_count: number;
  glue_type: string;
  glue_source: string | null;
  glue_remark: string | null;
  child_jobid: string | null;
  trigger_status: number;
  trigger_last_time: number;
  trigger_next_time: number;
  add_time: string | null;
  update_time: string | null;
}

export interface JobLog {
  id: number;
  job_group: number;
  job_id: number;
  executor_address: string | null;
  executor_handler: string | null;
  executor_param: string | null;
  executor_sharding_param: string | null;
  trigger_time: string | null;
  trigger_code: number;
  trigger_msg: string | null;
  handle_time: string | null;
  handle_code: number;
  handle_msg: string | null;
  alarm_status: number;
}

export interface LogReport {
  id: number;
  trigger_day: string | null;
  running_count: number;
  suc_count: number;
  fail_count: number;
}

export interface DashboardData {
  jobCount: number;
  runningJobs: number;
  groupCount: number;
  onlineGroups: number;
  today: { running: number; suc: number; fail: number };
}

export interface PageResult<T> {
  total: number;
  rows: T[];
}

export interface Meta {
  routeStrategies: string[];
  blockStrategies: string[];
  glueTypes: string[];
  misfireStrategies: string[];
  scheduleTypes: string[];
}

export interface SafeUser {
  id: number;
  username: string;
  role: number;
  permission: string | null;
}

export interface LogGlue {
  id: number;
  job_id: number;
  glue_type: string | null;
  glue_source: string | null;
  glue_remark: string;
  add_time: string | null;
  update_time: string | null;
}

export const fmtTime = (ms: number | null | undefined): string => {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
};
