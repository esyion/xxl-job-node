import os from 'node:os';
import http from 'node:http';
import type { JobExecutor } from '../executor/JobExecutor.js';
import {
  HEADER_ACCESS_TOKEN,
  HEADER_APPNAME,
  fail,
} from '../protocol/dto.js';
import type { Response, TriggerRequest } from '../protocol/dto.js';

/**
 * 执行器内嵌 HTTP 服务器（等价 Java 版 Netty EmbedServer）。
 * 仅暴露 5 个 POST 端点：/beat /idleBeat /trigger /kill /log，双 Header 鉴权。
 */
export class EmbedServer {
  private server: http.Server | null = null;

  async start(
    executor: JobExecutor,
    ip: string,
    startPort: number,
  ): Promise<number> {
    for (let port = startPort; port < startPort + 100; port++) {
      const server = http.createServer((req, res) => {
        void this.handle(executor, req, res);
      });
      try {
        await listen(server, ip, port);
        this.server = server;
        return port;
      } catch {
        // EADDRINUSE 等错误 → 换下一个端口重试
      }
    }
    throw new Error(`EmbedServer: no available port from ${startPort}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 存在 keep-alive 连接时 close 只停止接受新连接，强制销毁
      server.closeAllConnections?.();
      setTimeout(resolve, 3000);
    });
  }

  private async handle(
    executor: JobExecutor,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const send = (body: Response<unknown>) => {
      if (res.writableEnded) return;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method !== 'POST') {
        send(fail(`invalid request, http method(${req.method ?? 'unknown'}) not supported.`));
        return;
      }

      // 双 Header 鉴权：accessToken + appname 必须与执行器配置一致
      const token = String(req.headers[HEADER_ACCESS_TOKEN.toLowerCase()] ?? '');
      const appname = String(req.headers[HEADER_APPNAME.toLowerCase()] ?? '');
      if (!token || !appname || !executor.matchAuth(token, appname)) {
        send(fail('The access token or appname is incorrect.'));
        return;
      }

      const uri = (req.url ?? '').split('?')[0];
      const body = await readBody(req);
      const parsed: unknown = body ? JSON.parse(body) : {};

      switch (uri) {
        case '/beat':
          send(executor.beat());
          return;
        case '/idleBeat':
          send(executor.idleBeat(parsed as { jobId: number }));
          return;
        case '/trigger':
          send(executor.trigger(parsed as TriggerRequest));
          return;
        case '/kill':
          send(executor.kill(parsed as { jobId: number }));
          return;
        case '/log':
          send(await executor.log(parsed as { logDateTim: number; logId: number; fromLineNum: number }));
          return;
        default:
          send(fail(`uri-mapping(${uri}) not found.`));
      }
    } catch (e) {
      send(fail(e instanceof Error ? e.message : String(e)));
    }
  }
}

function listen(server: http.Server, ip: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, ip, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 探测本机内网 IPv4（用于注册地址），失败回环地址 */
export function getLocalIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}
