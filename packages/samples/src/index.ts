import {
  JobExecutor,
  XxlJob,
  XxlJobHelper,
} from '@xxl-job-node/core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 方式一：类 + @XxlJob 方法装饰器（推荐）
 */
class DemoJobService {
  @XxlJob('demoJobHandler')
  async demoJobHandler(): Promise<void> {
    const param = XxlJobHelper.getJobParam();
    await XxlJobHelper.log(`demoJobHandler 执行中，参数：${param}`);

    // 模拟业务耗时
    await sleep(1000);

    // 分片参数（分片广播路由时可用）
    await XxlJobHelper.log(`分片：${XxlJobHelper.getShardIndex()}/${XxlJobHelper.getShardTotal()}`);

    // 默认成功；也可显式声明：XxlJobHelper.handleSuccess() / XxlJobHelper.handleFail('原因')
  }

  @XxlJob('shardingJobHandler')
  async shardingJobHandler(): Promise<void> {
    const index = XxlJobHelper.getShardIndex();
    const total = XxlJobHelper.getShardTotal();
    await XxlJobHelper.log(`分片任务：本机处理第 ${index} / ${total} 片`);
    // 实际场景：按 index/total 切分数据集各自处理
  }

  @XxlJob('timeoutJobHandler')
  async timeoutJobHandler(): Promise<void> {
    // 演示协作式取消：任务配置 5s 超时后 abortSignal 会触发
    const signal = XxlJobHelper.getAbortSignal();
    for (let i = 0; i < 30; i++) {
      if (signal.aborted) {
        await XxlJobHelper.log('收到终止信号，提前退出');
        return;
      }
      await sleep(1000);
      await XxlJobHelper.log(`运行 ${i + 1}s ...`);
    }
  }

  @XxlJob('failJobHandler')
  async failJobHandler(): Promise<void> {
    XxlJobHelper.handleFail('业务执行失败示例');
  }
}

/**
 * 方式二：函数式注册（简单场景）
 */
async function simpleJobHandler(): Promise<void> {
  await XxlJobHelper.log('简单函数式任务执行');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const executor = new JobExecutor({
    adminAddresses: process.env.XXL_JOB_ADMIN_ADDRESSES ?? 'http://127.0.0.1:8989',
    appname: process.env.XXL_JOB_APPNAME ?? 'xxl-job-node-sample',
    accessToken: process.env.XXL_JOB_ACCESS_TOKEN ?? 'default_token',
    port: process.env.XXL_JOB_PORT ? Number(process.env.XXL_JOB_PORT) : undefined,
    logPath: process.env.XXL_JOB_LOG_PATH,
    logRetentionDays: 30,
  });

  // 注册 handler
  executor.scanBean(new DemoJobService());
  executor.registerJobHandler('simpleJobHandler', simpleJobHandler);
  // worker 线程任务（CPU 密集场景）
  executor.registerJobWorker(
    'cpuHeavyJobHandler',
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'workers', 'cpuHeavy.worker.ts'),
  );

  await executor.start();

  // 优雅停机
  const shutdown = async () => {
    await executor.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
