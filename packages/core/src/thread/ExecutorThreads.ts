import fsp from 'node:fs/promises';
import path from 'node:path';
import { md5 } from '../util/misc.js';
import { postJson } from '../util/http.js';
import { fileAppender } from '../log/FileAppender.js';
import {
  HEADER_ACCESS_TOKEN,
  HEADER_APPNAME,
  BEAT_TIMEOUT,
  REGISTRY_GROUP_EXECUTOR,
} from '../protocol/dto.js';
import type { CallbackData, RegistryRequest } from '../protocol/dto.js';

export interface AdminTarget {
  adminAddresses: string[];
  accessToken: string;
  appname: string;
  timeoutSec: number;
}

function headersOf(t: AdminTarget): Record<string, string> {
  return {
    [HEADER_ACCESS_TOKEN]: t.accessToken,
    [HEADER_APPNAME]: t.appname,
  };
}

/** 注册心跳线程：每 30s 向任一 admin 上报，stop 时主动摘除 */
export class RegistryThread {
  private timer: ReturnType<typeof setInterval> | null = null;
  private target: AdminTarget | null = null;
  private request: RegistryRequest | null = null;

  start(target: AdminTarget, appname: string, address: string): void {
    this.target = target;
    this.request = {
      registryGroup: REGISTRY_GROUP_EXECUTOR,
      registryKey: appname,
      registryValue: address,
    };
    const tick = async () => {
      const t = this.target;
      const req = this.request;
      if (!t || !req) return;
      for (const admin of t.adminAddresses) {
        const res = await postJson(`${admin}/api/registry`, req, headersOf(t), t.timeoutSec);
        if (res?.code === 200) return; // 任一成功即可
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), BEAT_TIMEOUT * 1000);
  }

  /** 优雅下线：向全部 admin 发送摘除（尽力而为） */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const t = this.target;
    const req = this.request;
    if (!t || !req) return;
    for (const admin of t.adminAddresses) {
      await postJson(`${admin}/api/registryRemove`, req, headersOf(t), t.timeoutSec);
    }
  }
}

/** 回调线程：批量 50 条上报执行结果，全失败落盘 MD5 幂等文件，30s 重试 */
export class CallbackThread {
  private queue: CallbackData[] = [];
  private flushing = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private target: AdminTarget | null = null;

  start(target: AdminTarget): void {
    this.target = target;
    this.retryTimer = setInterval(() => void this.retryFiles(), BEAT_TIMEOUT * 1000);
  }

  async stop(): Promise<void> {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    await this.flush();
  }

  push(data: CallbackData): void {
    this.queue.push(data);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && this.target) {
        const batch = this.queue.splice(0, 50);
        await this.doCallback(batch);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async doCallback(list: CallbackData[]): Promise<boolean> {
    const t = this.target;
    if (!t) return false;
    for (const admin of t.adminAddresses) {
      const res = await postJson<unknown>(`${admin}/api/callback`, { data: list }, headersOf(t), t.timeoutSec);
      if (res?.code === 200) return true;
    }
    // 全部失败：内容 MD5 命名落盘（幂等去重），等待重试线程
    const json = JSON.stringify(list);
    const file = path.join(fileAppender.getCallbackLogPath(), `xxl-job-callback-${md5(json)}.log`);
    await fsp.writeFile(file, json, 'utf8');
    return false;
  }

  private async retryFiles(): Promise<void> {
    const dir = fileAppender.getCallbackLogPath();
    let files: string[];
    try {
      files = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of files) {
      if (!name.endsWith('.log')) continue;
      const file = path.join(dir, name);
      try {
        const json = await fsp.readFile(file, 'utf8');
        const list = JSON.parse(json) as CallbackData[];
        await fsp.unlink(file);
        await this.doCallback(list); // 失败会重新写同内容同名文件
      } catch {
        // 忽略单文件错误，等下一轮
      }
    }
  }
}
