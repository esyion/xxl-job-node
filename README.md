# XXL-JOB Node

[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![React](https://img.shields.io/badge/UI-React%20%2B%20shadcn%2Fui-purple)](https://ui.shadcn.com)

参考 [xxl-job](https://github.com/xuxueli/xxl-job) 3.5.x 架构复刻的 **Node.js / TypeScript** 分布式任务调度平台。调度模型、通信协议、数据库表结构与 Java 版对齐（部分端点语义一致），执行层替换为 Node 异步模型，并针对 Node 特性做了增强（worker_threads 真强杀、AsyncLocalStorage 上下文）。

> 纯 TypeScript 实现，无一行 JavaScript；执行器 SDK 零运行时依赖。

## 架构

```
┌──────────────── admin（调度中心，可集群）────────────────┐
│ ScheduleCore   FOR UPDATE 行锁 + 5s 预读 + 60 槽时间轮      │
│ TriggerPool    fast/slow 双并发池 + 慢任务降级              │
│ Routes         10 种路由策略（含一致性哈希/故障转移/分片广播）│
│ Helpers        注册发现 / 回调完成 / 告警重试 / 报表清理     │
│ Fastify API    openapi（executor 协议）+ 管理 REST         │
└───────────────────────┬──────────────────────────────┘
                        │ JSON over HTTP（双 Header 鉴权）
┌───────────────────────┴──────────────────────────────┐
│ core（执行器 SDK，零运行时依赖）                          │
│ EmbedServer    /beat /idleBeat /trigger /kill /log      │
│ JobQueue       每 jobId 串行队列 + 阻塞策略 + 超时 + kill  │
│ AsyncLocalStorage 任务上下文（跨 await 自动传播）           │
│ Registry/Callback 30s 心跳注册 / 批量回调 + MD5 文件重试   │
└──────────────────────────────────────────────────────┘
```

## 包结构

| 包 | 说明 |
|---|---|
| `packages/core` | 执行器 SDK：`JobExecutor` + `@XxlJob` 装饰器 + `XxlJobHelper` 静态 API + worker_threads 池 |
| `packages/admin` | 调度中心：调度内核 + 触发链路 + Fastify REST + 用户/权限 + 邮件告警 |
| `packages/web` | 控制台：Vite + React + TS + shadcn/ui（46 个组件全量安装），含 Cron 可视化构建器 |
| `packages/samples` | 无框架接入示例（装饰器 / 函数式 / worker 三种注册） |
| `doc/db` | 数据库初始化脚本（兼容 xxl-job 3.5.x 表结构） |
| `docker/` | admin / web 镜像构建文件与 nginx 配置 |

## 功能总览

- **调度**：CRON（含可视化构建器）/ 固定频率、misfire 补偿、集群行锁互斥、60 槽时间轮秒级准点
- **路由**：10 种策略（首个/轮询/随机/一致性哈希/LFU/LRU/故障转移/忙碌转移/分片广播…）
- **执行**：串行队列 + 三种阻塞策略、超时控制、worker_threads 隔离 CPU 密集任务（可真强杀）
- **任务类型**：BEAN（进程内函数）、GLUE 脚本（Shell/Python/Nodejs/PowerShell，在线编辑 + 版本回滚 + 运行中热更）
- **可靠性**：回调批量上报 + 失败落盘重试、结果丢失兜底、失败重试、CAS 告警去重（邮件/控制台）
- **管控**：用户管理与执行器组级数据权限、第三方 OpenAPI 六接口（令牌桶限流）、运行报表、日志滚动查看与终止

## 快速开始

### 1. 初始化数据库

```sql
-- MySQL 5.7+/8.x 执行
source doc/db/tables_xxl_job.sql
```

默认账号 `admin / 123456`（sha256）。

### 2. 启动调度中心

```bash
cd packages/admin
export XXL_JOB_DB_HOST=127.0.0.1
export XXL_JOB_DB_USER=root
export XXL_JOB_DB_PASSWORD=xxx
pnpm dev          # tsx watch，默认监听 8989
```

### 3. 启动控制台

```bash
cd packages/web
pnpm dev          # vite，5173，/api 代理到 8989
```

浏览器打开 http://localhost:5173 ，登录 `admin / 123456`。

### 4. 接入执行器（业务项目）

```bash
pnpm add @xxl-job-node/core
```

```ts
import { JobExecutor, XxlJob, XxlJobHelper } from '@xxl-job-node/core'

class DemoJobService {
  @XxlJob('demoJobHandler')
  async demoJobHandler(): Promise<void> {
    const param = XxlJobHelper.getJobParam()
    await XxlJobHelper.log(`参数：${param}`)
    // 分片：XxlJobHelper.getShardIndex() / getShardTotal()
    // 长任务协作取消：XxlJobHelper.getAbortSignal().aborted
    // 显式结果：XxlJobHelper.handleSuccess() / handleFail('原因')
  }
}

const executor = new JobExecutor({
  adminAddresses: 'http://127.0.0.1:8989',   // 多地址逗号分隔
  appname: 'my-app',
  accessToken: 'default_token',              // 与执行器组配置一致
  port: 9999,                                // 可选，缺省自动探测
})
executor.scanBean(new DemoJobService())
await executor.start()
```

或在控制台创建执行器（AppName=`my-app`）与任务（JobHandler=`demoJobHandler`，Cron=`0 * * * * ? *`）。

### 5. 本地跑示例

```bash
cd packages/samples
pnpm dev       # appname=xxl-job-node-sample，端口 9999
```

## 核心机制（与 Java 版对齐）

| 机制 | 实现 |
|---|---|
| 集群调度互斥 | 事务内 `SELECT ... FOR UPDATE`（xxl_job_lock），持锁期=扫描+回写 |
| 秒级准点 | scheduleThread 每秒预读未来 5s 任务 → 60 槽内存时间轮（回看 3 槽容错） |
| misfire | 过期 >5s：DO_NOTHING / FIRE_ONCE_NOW |
| 触发状态机 | 先写 xxl_job_log 拿 logId 再触发；logId = 全链路幂等键 |
| 阻塞策略 | SERIAL_EXECUTION / DISCARD_LATER / COVER_EARLY |
| 超时 | BEAN/脚本：`Promise.race` + `AbortController`（502）；worker：`terminate()` 真杀 |
| 回调可靠性 | 批量 50 条上报，全失败落盘（内容 MD5 命名），30s 重试 |
| 丢失兜底 | trigger 成功 + 10min 无回调 + 执行器离线 → 标记 joblog_lost_fail |
| 告警去重 | `UPDATE ... WHERE alarm_status=0` CAS 抢锁，多 admin 不重复 |
| 注册发现 | 30s 心跳 / 90s 判死，聚合回写组地址列表 |
| 脚本任务 | GLUE_SHELL / GLUE_PYTHON / GLUE_NODEJS / GLUE_POWERSHELL（源码落盘 + 子进程执行 + 实时日志） |
| 级联子任务 | 父任务成功后按 childJobId 依次触发 |
| 数据权限 | 普通用户按执行器组隔离任务/日志/操作；管理员全量 |
| OpenAPI | addJob/updateJob/removeJob/startJob/stopJob/triggerJob，令牌桶 100 次/30s |

## CPU 密集任务：worker 模式

普通 handler 跑在事件循环里，CPU 密集任务会阻塞执行器。`registerJobWorker` 把任务放进独立 `worker_threads`：

```ts
// workers/heavy.worker.ts
import { runAsWorker } from '@xxl-job-node/core'
runAsWorker(async (ctx) => {
  console.log('参数：', ctx.executorParams)   // 自动写入任务日志
  // CPU 密集逻辑；超时/终止时 worker.terminate() 真正杀掉
})

// 注册（主线程）
executor.registerJobWorker('heavyJob', new URL('./workers/heavy.worker.ts', import.meta.url).pathname)
```

隔离性验证：CPU 任务运行期间 `/beat`、`/log` 端点保持毫秒级响应；超时 1s 可强杀 3s 的死循环计算。

## 第三方 OpenAPI（程序化管理任务）

```bash
curl -X POST http://127.0.0.1:8989/api/addJob \
  -H 'XXL-JOB-APPNAME: my-app' -H 'XXL-JOB-ACCESS-TOKEN: default_token' \
  -H 'content-type: application/json' \
  -d '{"appname":"my-app","name":"同步任务","scheduleType":"CRON","scheduleConf":"0 0/5 * * * ?","executorHandler":"syncJob"}'
```

六接口：`/api/addJob` `/api/updateJob` `/api/removeJob` `/api/startJob` `/api/stopJob` `/api/triggerJob`（triggerJob 支持 `executorParam`、`addressList` 覆盖）。组级双 Header 鉴权，令牌桶限流 100 次/30s。

## 邮件告警（可选）

```bash
export XXL_JOB_SMTP_HOST=smtp.example.com
export XXL_JOB_SMTP_PORT=465
export XXL_JOB_SMTP_SSL=true
export XXL_JOB_SMTP_USER=alert@example.com
export XXL_JOB_SMTP_PASS=xxx
export XXL_JOB_SMTP_FROM="XXL-JOB <alert@example.com>"
```

未配置时自动降级为控制台告警；任务 `alarm_email` 填收件人（逗号分隔）。

## Docker 部署

```bash
docker compose up -d --build          # mysql + admin + web
docker compose --profile sample up -d # 附加示例执行器
```

MySQL 首次启动自动执行 `doc/db/tables_xxl_job.sql`；web（nginx :5173）将 `/api` 反代到 admin（:8989）。

## 环境变量（admin）

| 变量 | 默认 | 说明 |
|---|---|---|
| `XXL_JOB_ADMIN_PORT` | 8989 | HTTP 端口 |
| `XXL_JOB_DB_HOST/PORT/USER/PASSWORD/NAME` | 127.0.0.1/3306/root//xxl_job | 数据库 |
| `XXL_JOB_TRIGGERPOOL_FAST_MAX / SLOW_MAX` | 300/200 | 触发池并发 |
| `XXL_JOB_LOG_RETENTION_DAYS` | 30 | 日志保留天数（<3 关闭） |
| `XXL_JOB_RPC_TIMEOUT` | 3 | 触发 RPC 超时（秒） |

## 与 Java 版差异

- 执行模型：每 job 串行队列由 Promise 链驱动（非线程），上下文用 `AsyncLocalStorage`（等价 InheritableThreadLocal）；CPU 密集任务用 `worker_threads`（超时/终止可真杀，强于 Java 版 interrupt）
- GLUE_Groovy（Java 源码热加载）未实现——Node 生态下建议正常发版部署；脚本型 GLUE 已实现（含版本历史与回滚）
- 触发端点为 `/trigger`（对齐 3.5.x，旧版 2.x 为 `/run`）；鉴权为 accessToken + appname 双 Header
- 用户/权限：普通用户按执行器组隔离数据；邮件告警可选（未配置降级控制台）
- i18n 与 xxl-sso 集成未实现（按需求裁剪）

## License

MIT

## 致谢

- **[xxl-job](https://github.com/xuxueli/xxl-job)**（许雪里）—— 本项目的架构蓝本。行锁调度 + 时间轮、触发-回调状态机、路由策略、注册发现等核心设计均来自对 xxl-job 3.5.x 源码的研读与复刻，数据库表结构与之兼容。强烈推荐阅读原项目。
- **[croner](https://github.com/hexagon/croner)** —— 零依赖的 cron 解析与下次触发计算。
- **[cronstrue](https://github.com/bradymiller/cronstrue)** —— Cron 表达式的中文自然语言翻译。
- **[shadcn/ui](https://ui.shadcn.com)** —— 控制台全部 UI 组件体系。
- **[Fastify](https://fastify.dev)** / **[mysql2](https://github.com/sidorares/node-mysql2)** / **[nodemailer](https://nodemailer.com)** / **[Vite](https://vite.dev)** / **[tsx](https://tsx.is)** —— 调度中心与工程化的基础。

本项目为学习研究 xxl-job 设计思想的独立实现（TypeScript / Node.js 原创代码），未包含原项目源码。

## License

[MIT](./LICENSE) © esyion
