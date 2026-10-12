import type { XxlJobContext } from '../context/XxlJobContext.js';
import { GLUE_TYPES } from '../protocol/dto.js';

/**
 * 任务 handler：一个异步函数。参数与结果都通过 XxlJobHelper 静态 API 获取/设置。
 * abortSignal 用于协作式取消（kill / COVER_EARLY / 超时），长任务应周期性检查。
 */
export type JobHandler = (abortSignal: AbortSignal) => Promise<void> | void;

/** @XxlJob 装饰器收集的元数据 */
export interface JobHandlerMeta {
  name: string;
  key: string | symbol;
}

const XXL_JOB_METHODS = Symbol('xxl-job:methods');

/**
 * 方法级任务注解，等价 Java 版 @XxlJob("handlerName")。
 * 用 executor.scanBean(instance) 扫描收集。
 * 兼容 ES2022 标准装饰器与 legacy 装饰器两种调用形态。
 */
export function XxlJob(name: string) {
  return (
    target: object,
    propertyKeyOrContext: string | symbol | ClassMethodDecoratorContext,
    _descriptor?: unknown,
  ): void => {
    const key: string | symbol =
      typeof propertyKeyOrContext === 'object' && propertyKeyOrContext !== null
        ? (propertyKeyOrContext as ClassMethodDecoratorContext).name as string | symbol
        : (propertyKeyOrContext as string | symbol);
    const list: JobHandlerMeta[] = ((target as Record<symbol, JobHandlerMeta[]>)[XXL_JOB_METHODS] ??= []);
    list.push({ name, key });
  };
}

/**
 * 收集实例上带 @XxlJob 注解的方法元数据。
 * ES2022 标准装饰器把元数据挂在方法函数上，legacy 装饰器挂在原型上，两处都查。
 */
export function getJobMethodMeta(instance: object): JobHandlerMeta[] {
  const result: JobHandlerMeta[] = [];
  const proto = Object.getPrototypeOf(instance) as Record<string, unknown> | null;
    if (proto) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      const fn = (proto as Record<string, unknown>)[key];
      if (typeof fn === 'function') {
        const metas = (fn as unknown as Record<symbol, JobHandlerMeta[]>)[XXL_JOB_METHODS];
        if (metas) result.push(...metas);
      }
    }
    const legacy = (proto as Record<symbol, JobHandlerMeta[]>)[XXL_JOB_METHODS];
    if (legacy) result.push(...legacy);
  }
  return result;
}

/** 判断 glueType 是否脚本任务 */
export function isScriptGlue(glueType: string): boolean {
  return GLUE_TYPES[glueType as keyof typeof GLUE_TYPES]?.isScript ?? false;
}

export type { XxlJobContext };
