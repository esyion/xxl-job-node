import { runAsWorker } from '@xxl-job-node/core';

/**
 * CPU 密集任务示例：跑在独立 worker 线程中，
 * 不阻塞执行器主线程（/beat /log 等端点保持响应），
 * 超时/终止时由调度方 worker.terminate() 真正杀掉。
 *
 * console.log/warn/error 会自动写入任务日志文件。
 */
runAsWorker(async (ctx) => {
  console.log(`cpuHeavyJob 开始，参数：${ctx.executorParams}，分片：${ctx.shardIndex}/${ctx.shardTotal}`);

  // 模拟 CPU 密集计算：纯计算 3 秒
  const start = Date.now();
  let x = 0;
  while (Date.now() - start < 3000) {
    x += Math.sqrt(x + 1);
  }
  console.log(`计算完成，迭代样值=${x.toFixed(4)}`);

  // 抛错 = 任务失败；正常返回 = 成功
});
