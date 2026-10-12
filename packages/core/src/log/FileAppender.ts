import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { formatDate } from '../util/misc.js';
import type { LogData } from '../protocol/dto.js';

/**
 * 任务日志 Appender：
 *   {logBasePath}/yyyy-MM-dd/{logId}.log   —— 每次执行一个文件
 *   {logBasePath}/gluesource/              —— 脚本任务源码缓存
 *   {logBasePath}/callbacklogs/            —— 回调失败重试文件
 */
export class FileAppender {
  private logBasePath = '';

  initLogPath(logPath: string): void {
    this.logBasePath = logPath;
    for (const sub of ['', 'gluesource', 'callbacklogs']) {
      fs.mkdirSync(path.join(logPath, sub), { recursive: true });
    }
  }

  getLogBasePath(): string {
    return this.logBasePath;
  }

  getGlueSrcPath(): string {
    return path.join(this.logBasePath, 'gluesource');
  }

  getCallbackLogPath(): string {
    return path.join(this.logBasePath, 'callbacklogs');
  }

  /** 生成日志文件名：{base}/yyyy-MM-dd/{logId}.log */
  makeLogFileName(triggerDate: Date, logId: number): string {
    const dayDir = path.join(this.logBasePath, formatDate(triggerDate));
    fs.mkdirSync(dayDir, { recursive: true });
    return path.join(dayDir, `${logId}.log`);
  }

  /** 追加一行日志（自动换行） */
  async appendLog(logFileName: string, appendLog: string): Promise<void> {
    const line = appendLog.endsWith('\n') ? appendLog : appendLog + '\n';
    await fsp.appendFile(logFileName, line, 'utf8');
  }

  /** 从 fromLineNum（1 起）读到文件尾，返回游标供前端滚动续读 */
  async readLog(logFileName: string, fromLineNum: number): Promise<LogData | null> {
    let content: string;
    try {
      content = await fsp.readFile(logFileName, 'utf8');
    } catch {
      return { fromLineNum, toLineNum: fromLineNum, logContent: '', isEnd: true };
    }
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const toLineNum = lines.length;
    if (fromLineNum > toLineNum) {
      return { fromLineNum, toLineNum, logContent: '', isEnd: true };
    }
    return {
      fromLineNum,
      toLineNum,
      logContent: lines.slice(fromLineNum - 1).join('\r\n'),
      isEnd: true,
    };
  }

  /** 清理超过保留天数的日期目录，返回删除的目录数 */
  async cleanOldLog(retentionDays: number): Promise<number> {
    const entries = await fsp.readdir(this.logBasePath, { withFileTypes: true });
    const deadline = Date.now() - retentionDays * 24 * 3600 * 1000;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      const dayMs = new Date(`${entry.name}T00:00:00`).getTime();
      if (Number.isNaN(dayMs) || dayMs >= deadline) continue;
      await fsp.rm(path.join(this.logBasePath, entry.name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }

  /** 脚本源码落盘（文件名含更新时间实现版本缓存） */
  async markScriptFile(scriptFileName: string, scriptContent: string): Promise<void> {
    await fsp.writeFile(scriptFileName, scriptContent, 'utf8');
  }
}

/** 进程级单例（一个进程只应有一个执行器） */
export const fileAppender = new FileAppender();
