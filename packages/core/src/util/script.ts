import fs from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * 执行脚本文件并把 stdout/stderr 实时追加到日志文件。
 * 等价 Java 版 ScriptUtil.execToFile：进程退出码即执行结果。
 */
export function execToFile(
  cmd: string,
  scriptFile: string,
  logFile: string,
  params: string[],
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(cmd, [scriptFile, ...params], { windowsHide: true });

    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });

    child.on('error', (err) => {
      cleanup();
      out.end();
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      out.end();
      resolve(code ?? -1);
    });
  });
}
