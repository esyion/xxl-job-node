import { createHash } from 'node:crypto';
import type { XxlJobGroup } from '../db/entities.js';
import type { TriggerRequest } from '@xxl-job-node/core';
import { postJson } from './executorClient.js';

/**
 * 10 种路由策略（与 Java 版语义对齐）。
 * 返回 null 表示无可用地 址；FAILOVER/BUSYOVER 会实时探活。
 */
export type RouteStrategy = 'FIRST' | 'LAST' | 'ROUND' | 'RANDOM' | 'CONSISTENT_HASH' | 'LFU' | 'LRU' | 'FAILOVER' | 'BUSYOVER' | 'SHARDING_BROADCAST';

export const ROUTE_STRATEGIES: RouteStrategy[] = [
  'FIRST', 'LAST', 'ROUND', 'RANDOM', 'CONSISTENT_HASH', 'LFU', 'LRU', 'FAILOVER', 'BUSYOVER', 'SHARDING_BROADCAST',
];

export interface RouteContext {
  group: XxlJobGroup;
  triggerRequest: TriggerRequest;
  timeoutSec: number;
}

// ---------- FIRST / LAST ----------

function routeFirst(ctx: RouteContext): string | null {
  return ctx.group.registryList()[0] ?? null;
}

function routeLast(ctx: RouteContext): string | null {
  const list = ctx.group.registryList();
  return list[list.length - 1] ?? null;
}

// ---------- ROUND：每 job 计数取模，初始随机 ----------

const roundCounters = new Map<number, number>();

function routeRound(ctx: RouteContext): string | null {
  const list = ctx.group.registryList();
  if (!list.length) return null;
  const jobId = ctx.triggerRequest.jobId;
  let counter = roundCounters.get(jobId);
  if (counter === undefined) {
    counter = Math.floor(Math.random() * list.length);
  } else {
    counter++;
    if (counter > 1_000_000) counter = 0; // 防溢出重置
  }
  roundCounters.set(jobId, counter);
  return list[counter % list.length] ?? null;
}

// ---------- RANDOM ----------

function routeRandom(ctx: RouteContext): string | null {
  const list = ctx.group.registryList();
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)] ?? null;
}

// ---------- CONSISTENT_HASH：MD5 哈希环 + 100 虚拟节点 ----------

const VIRTUAL_NODE_NUM = 100;
const hashRingCache = new Map<string, TreeMap>();

class TreeMap {
  private sorted: Array<{ hash: number; address: string }> = [];
  put(hash: number, address: string): void {
    this.sorted.push({ hash, address });
  }
  ready(): void {
    this.sorted.sort((a, b) => a.hash - b.hash);
  }
  ceiling(hash: number): string | null {
    for (const item of this.sorted) {
      if (item.hash >= hash) return item.address;
    }
    return this.sorted[0]?.address ?? null; // 回环取首节点
  }
}

function hash32(input: string): number {
  const digest = createHash('md5').update(input, 'utf8').digest();
  return digest.readUInt32BE(0); // 取前 4 字节作 32 位环空间
}

function getHashRing(key: string, addresses: string[]): TreeMap {
  const cacheKey = `${key}|${addresses.join(',')}`;
  const cached = hashRingCache.get(cacheKey);
  if (cached) return cached;
  const ring = new TreeMap();
  for (const address of addresses) {
    for (let i = 0; i < VIRTUAL_NODE_NUM; i++) {
      ring.put(hash32(`SHARD-${address}-NODE-${i}`), address);
    }
  }
  ring.ready();
  hashRingCache.set(cacheKey, ring);
  return ring;
}

function routeConsistentHash(ctx: RouteContext): string | null {
  const list = ctx.group.registryList();
  if (!list.length) return null;
  const ring = getHashRing(String(ctx.triggerRequest.jobId), list);
  return ring.ceiling(hash32(String(ctx.triggerRequest.jobId)));
}

// ---------- LFU：最小使用频率优先，24h 清空 ----------

const lfuItems = new Map<number, { minuteTs: number; map: Map<string, number> }>();
const DAY_MS = 24 * 3600 * 1000;

function routeLfu(ctx: RouteContext): string | null {
  const list = ctx.group.registryList();
  if (!list.length) return null;
  const jobId = ctx.triggerRequest.jobId;
  let item = lfuItems.get(jobId);
  if (!item || Date.now() - item.minuteTs > DAY_MS) {
    item = { minuteTs: Date.now(), map: new Map() };
    // 新地址随机初值，避免集中打到新机器
    for (const address of list) item.map.set(address, Math.floor(Math.random() * list.length));
    lfuItems.set(jobId, item);
  }
  // 剔除已下线地址
  for (const key of item.map.keys()) {
    if (!list.includes(key)) item.map.delete(key);
  }
  for (const address of list) {
    if (!item.map.has(address)) item.map.set(address, 0);
  }
  let lessAddress: string | null = null;
  let lessCount = Number.MAX_SAFE_INTEGER;
  for (const [address, count] of item.map) {
    if (count < lessCount) {
      lessCount = count;
      lessAddress = address;
    }
  }
  if (lessAddress !== null) item.map.set(lessAddress, (item.map.get(lessAddress) ?? 0) + 1);
  return lessAddress ?? list[0] ?? null;
}

// ---------- LRU：最近最久未使用优先 ----------

const lruItems = new Map<number, { minuteTs: number; map: Map<string, string> }>();

function routeLru(ctx: RouteContext): string | null {
  const list = ctx.group.registryList();
  if (!list.length) return null;
  const jobId = ctx.triggerRequest.jobId;
  let item = lruItems.get(jobId);
  if (!item || Date.now() - item.minuteTs > DAY_MS) {
    item = { minuteTs: Date.now(), map: new Map() };
    for (const address of list) item.map.set(address, address); // 插入序即使用序
    lruItems.set(jobId, item);
  }
  for (const key of item.map.keys()) {
    if (!list.includes(key)) item.map.delete(key);
  }
  for (const address of list) {
    if (!item.map.has(address)) item.map.set(address, address);
  }
  // 取 eldest（Map 首个 = 最久未使用），并刷新到末尾
  const eldest = item.map.keys().next().value ?? list[0];
  if (eldest !== undefined) {
    item.map.delete(eldest);
    item.map.set(eldest, eldest);
    return eldest;
  }
  return list[0] ?? null;
}

// ---------- FAILOVER：逐台 beat 实时探活 ----------

async function routeFailover(ctx: RouteContext): Promise<string | null> {
  for (const address of ctx.group.registryList()) {
    const res = await postJson(`${address}/beat`, {}, ctx.group, ctx.timeoutSec);
    if (res?.code === 200) return address;
  }
  return null;
}

// ---------- BUSYOVER：逐台 idleBeat 找空闲 ----------

async function routeBusyover(ctx: RouteContext): Promise<string | null> {
  for (const address of ctx.group.registryList()) {
    const res = await postJson(
      `${address}/idleBeat`,
      { jobId: ctx.triggerRequest.jobId },
      ctx.group,
      ctx.timeoutSec,
    );
    if (res?.code === 200) return address;
  }
  return null;
}

// ---------- 分发入口 ----------

export async function route(
  strategy: string,
  ctx: RouteContext,
): Promise<string | null> {
  switch (strategy) {
    case 'FIRST': return routeFirst(ctx);
    case 'LAST': return routeLast(ctx);
    case 'ROUND': return routeRound(ctx);
    case 'RANDOM': return routeRandom(ctx);
    case 'CONSISTENT_HASH': return routeConsistentHash(ctx);
    case 'LFU': return routeLfu(ctx);
    case 'LRU': return routeLru(ctx);
    case 'FAILOVER': return routeFailover(ctx);
    case 'BUSYOVER': return routeBusyover(ctx);
    default: return routeFirst(ctx);
  }
}
