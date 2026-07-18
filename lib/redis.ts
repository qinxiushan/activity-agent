/**
 * lib/redis.ts — Redis 连接管理（阶段 2 T0）
 *
 * 设计原则（与 lib/db.ts 对称）：
 * 1. 惰性单例 + globalThis 挂载（dev 热重载安全）
 * 2. 未配置 REDIS_URL 时：isRedisConfigured()=false、pingRedis()=false、getRedis() 抛错
 * 3. fail-fast 配置：enableOfflineQueue=false —— Redis 失联时命令立即失败，
 *    供 T2 限流器快速降级到内存窗口，而不是无限排队拖垮请求
 * 4. error 事件必须有 handler（ioredis 未处理的 error 事件会打爆日志/崩进程），
 *    降噪：同类错误 30s 只打一条
 */

import Redis from "ioredis";

declare global {
  // eslint-disable-next-line no-var
  var __redisClient: Redis | undefined;
}

let lastErrorLogAt = 0;
const ERROR_LOG_INTERVAL_MS = 30_000;

export function isRedisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL);
}

export function getRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("[redis] REDIS_URL is not configured");
  }
  if (!globalThis.__redisClient) {
    globalThis.__redisClient = new Redis(url, {
      lazyConnect: true, // 首个命令才建连，import 本模块零副作用
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false, // 失联时命令立即报错（限流器据此降级）
      retryStrategy: (times) => Math.min(times * 500, 5_000), // 断线后台重连，上限 5s
    });
    globalThis.__redisClient.on("error", (err) => {
      const now = Date.now();
      if (now - lastErrorLogAt > ERROR_LOG_INTERVAL_MS) {
        lastErrorLogAt = now;
        console.error("[redis] connection error (throttled log):", err.message);
      }
    });
  }
  return globalThis.__redisClient;
}

/**
 * 健康探测：限时 PING。
 * 未配置 / 失联 / 超时 → false，绝不抛错。
 *
 * 注意：lazyConnect + enableOfflineQueue=false 组合下，连接建立前发出的
 * 命令会被立即拒绝——因此 status="wait" 时必须先显式 connect() 再 ping。
 */
export async function pingRedis(timeoutMs = 800): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  try {
    const client = getRedis();
    const connectAndPing = (async () => {
      if (client.status === "wait") await client.connect();
      return client.ping();
    })();
    const pong = await Promise.race([
      connectAndPing,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("ping timeout")), timeoutMs),
      ),
    ]);
    return pong === "PONG";
  } catch {
    return false;
  }
}

/** 优雅关停（T4 SIGTERM 流程使用）。未初始化时为 no-op。 */
export async function closeRedis(): Promise<void> {
  if (globalThis.__redisClient) {
    const client = globalThis.__redisClient;
    globalThis.__redisClient = undefined;
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}
