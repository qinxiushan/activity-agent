/**
 * lib/db.ts — PostgreSQL 连接管理（阶段 2 T0）
 *
 * 设计原则：
 * 1. 惰性单例：首次 getPool() 才创建连接池；未配置 DATABASE_URL 时模块可安全 import
 * 2. globalThis 挂载：dev server 热重载不会重置模块级单例（交接说明 §4.2 坑），
 *    挂到 globalThis 避免每次热重载泄漏一个连接池
 * 3. 未配置时的行为约定：
 *    - isDbConfigured() → false
 *    - pingDb() → false（不抛错，供健康检查安全调用）
 *    - getPool() → 抛错（业务代码必须先判断 isDbConfigured 或由上层开关控制）
 */

import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[db] DATABASE_URL is not configured");
  }
  if (!globalThis.__pgPool) {
    globalThis.__pgPool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // 空闲连接层面的错误（如 PG 重启）不应导致进程崩溃
    globalThis.__pgPool.on("error", (err) => {
      console.error("[db] idle client error:", err.message);
    });
  }
  return globalThis.__pgPool;
}

/**
 * 健康探测：限时 SELECT 1。
 * 未配置 / 连接失败 / 超时 → false，绝不抛错。
 */
export async function pingDb(timeoutMs = 800): Promise<boolean> {
  if (!isDbConfigured()) return false;
  try {
    await Promise.race([
      getPool().query("SELECT 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("ping timeout")), timeoutMs),
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** 优雅关停（T4 SIGTERM 流程使用）。未初始化时为 no-op。 */
export async function closePool(): Promise<void> {
  if (globalThis.__pgPool) {
    const pool = globalThis.__pgPool;
    globalThis.__pgPool = undefined;
    await pool.end().catch((e) => {
      console.error("[db] pool.end failed:", e instanceof Error ? e.message : e);
    });
  }
}
