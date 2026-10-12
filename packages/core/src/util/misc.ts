import { createHash } from 'node:crypto';

export function md5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const pad = (n: number, len = 2): string => String(n).padStart(len, '0');

/** yyyy-MM-dd */
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** yyyy-MM-dd HH:mm:ss */
export function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 睡到下一个 ms 边界对齐（对齐时间轮/心跳节拍用） */
export async function sleepUntilAligned(intervalMs: number): Promise<void> {
  const now = Date.now();
  const next = Math.ceil((now + 1) / intervalMs) * intervalMs;
  await sleep(next - now);
}

/** 以固定间隔循环执行，节拍对齐边界；fn 抛错只记录不打断 */
export function startAlignedLoop(
  name: string,
  intervalMs: number,
  fn: () => Promise<void>,
  onError: (e: unknown) => void,
): { stop: () => Promise<void> } {
  let running = true;
  let waiters: Array<() => void> = [];
  void (async () => {
    await sleepUntilAligned(intervalMs);
    while (running) {
      try {
        await fn();
      } catch (e) {
        onError(e);
      }
      if (!running) break;
      await sleepUntilAligned(intervalMs);
    }
    waiters.forEach((w) => w());
    waiters = [];
  })();
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        running = false;
        // fn 正在执行时由循环退出时唤醒；否则直接唤醒
        const timer = setTimeout(resolve, intervalMs + 2000);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}
