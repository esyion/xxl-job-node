/**
 * 通信协议：与 xxl-job 3.5.x 对齐的 DTO 与常量。
 * 传输层为 JSON over HTTP（POST，URI = 端点名），双向双 Header 鉴权。
 */

// ==================== 常量 ====================

export const HEADER_ACCESS_TOKEN = 'XXL-JOB-ACCESS-TOKEN';
export const HEADER_APPNAME = 'XXL-JOB-APPNAME';

export const CODE_SUCCESS = 200;
export const CODE_FAIL = 500;
export const CODE_TIMEOUT = 502;
export const CODE_NO_CHANGE = 0;

/** 执行器心跳/注册间隔（秒） */
export const BEAT_TIMEOUT = 30;
/** 注册失效阈值 = 3 倍心跳（秒） */
export const DEAD_TIMEOUT = 90;
/** 调度预读窗口（毫秒） */
export const PRE_READ_MS = 5000;

// ==================== 统一响应 ====================

export interface Response<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

export const ok = <T>(data?: T, msg = 'success'): Response<T> => ({ code: CODE_SUCCESS, msg, data });
export const fail = (msg: string): Response<never> => ({ code: CODE_FAIL, msg });
export const isOk = (r: Response<unknown>): boolean => r.code === CODE_SUCCESS;

// ==================== admin -> executor ====================

export type BlockStrategy = 'SERIAL_EXECUTION' | 'DISCARD_LATER' | 'COVER_EARLY';

/** 触发请求（admin -> executor POST /trigger） */
export interface TriggerRequest {
  jobId: number;
  executorHandler: string;
  executorParams: string;
  executorBlockStrategy: BlockStrategy;
  /** 秒；0 = 不限时 */
  executorTimeout: number;
  /** 本次执行的日志 ID，全链路幂等键 */
  logId: number;
  /** 触发时刻（毫秒），用于定位日志文件 */
  logDateTime: number;
  glueType: GlueType;
  glueSource: string;
  glueUpdatetime: number;
  broadcastIndex: number;
  broadcastTotal: number;
}

export interface IdleBeatRequest {
  jobId: number;
}

export interface KillRequest {
  jobId: number;
}

export interface LogRequest {
  /** 触发时刻（毫秒），用于定位日志日期目录 */
  logDateTim: number;
  logId: number;
  fromLineNum: number;
}

export interface LogData {
  fromLineNum: number;
  toLineNum: number;
  logContent: string;
  isEnd: boolean;
}

// ==================== executor -> admin ====================

export interface CallbackData {
  logId: number;
  logDateTime: number;
  handleCode: number;
  handleMsg: string;
}

export interface CallbackRequest {
  data: CallbackData[];
}

export interface RegistryRequest {
  registryGroup: string;
  registryKey: string;
  registryValue: string;
}

export const REGISTRY_GROUP_EXECUTOR = 'EXECUTOR';

// ==================== GLUE / 脚本 ====================

export type GlueType =
  | 'BEAN'
  | 'GLUE_SHELL'
  | 'GLUE_PYTHON'
  | 'GLUE_NODEJS'
  | 'GLUE_POWERSHELL';

export interface GlueTypeInfo {
  isScript: boolean;
  cmd?: string;
  suffix?: string;
}

export const GLUE_TYPES: Record<GlueType, GlueTypeInfo> = {
  BEAN: { isScript: false },
  GLUE_SHELL: { isScript: true, cmd: 'bash', suffix: '.sh' },
  GLUE_PYTHON: { isScript: true, cmd: 'python3', suffix: '.py' },
  GLUE_NODEJS: { isScript: true, cmd: 'node', suffix: '.js' },
  GLUE_POWERSHELL: { isScript: true, cmd: 'pwsh', suffix: '.ps1' },
};
