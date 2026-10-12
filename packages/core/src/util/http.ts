import type { Response } from '../protocol/dto.js';

/**
 * 统一 HTTP JSON POST（executor -> admin 方向）。
 * 网络失败/超时/非 2XX 一律返回 null，由调用方决定容错。
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutSec: number,
): Promise<Response<T> | null> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Response<T>;
  } catch {
    return null;
  }
}
