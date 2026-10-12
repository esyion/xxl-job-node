import { HEADER_ACCESS_TOKEN, HEADER_APPNAME } from '@xxl-job-node/core';
import type { Response } from '@xxl-job-node/core';
import type { XxlJobGroup } from '../db/entities.js';

/**
 * admin -> executor 的 HTTP 客户端（对齐 Java 版 HttpTool 代理调用）。
 * 协议：POST {address}/{uri}，body JSON，双 Header = 组级 accessToken + appname。
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  group: XxlJobGroup,
  timeoutSec: number,
): Promise<Response<T> | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [HEADER_ACCESS_TOKEN]: group.access_token ?? '',
        [HEADER_APPNAME]: group.app_name,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Response<T>;
  } catch {
    return null;
  }
}
