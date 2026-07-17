/**
 * Health Check Logic - 用于 /api/health 和 /api/health/ready
 *
 * 设计原则：
 * - 不引入新依赖（用 node:fs, node:os, node:process）
 * - 检查耗时 < 100ms（liveness 必须快）
 * - 失败信息可定位问题（readiness 返回具体哪项检查失败）
 *
 * 检查项：
 * 1. sessions 目录可写（pi session JSONL 文件）
 * 2. plan-states 目录可写（SOP 状态机持久化）
 * 3. bookings 目录可写（订单持久化）
 * 4. user-profiles 目录可写（用户偏好）
 * 5. 内存使用 < 90%（防止 OOM）
 * 6. 活跃 session 数（信息性，不阻塞）
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const MEMORY_HARD_LIMIT_MB = 1536;

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  checks: {
    sessions_dir_writable: boolean;
    plan_states_dir_writable: boolean;
    bookings_dir_writable: boolean;
    user_profiles_dir_writable: boolean;
    memory_under_threshold: boolean;
  };
  details?: {
    memoryUsedMb: number;
    memoryLimitMb: number;
    activeSessions: number;
  };
  error?: string;
}

const REQUIRED_DIRS = [
  "sessions",
  "plan-states",
  "bookings",
  "user-profiles",
] as const;

const MEMORY_THRESHOLD_PERCENT = 0.9;

/**
 * 检查单个目录是否可写（写一个临时文件再删除）
 */
async function checkDirWritable(dirPath: string): Promise<boolean> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    const probeFile = path.join(
      dirPath,
      `.health-check-${process.pid}-${Date.now()}`,
    );
    await fs.writeFile(probeFile, "ok", "utf-8");
    await fs.unlink(probeFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * 收集活跃 session 数（从 globalThis 读取，进程内）
 *
 * 注意：这是进程内的 Map，多节点部署时这个值不准确。
 * 阶段 2 会改为从 Redis 聚合。
 */
function getActiveSessionCount(): number {
  // rpc-manager.ts 暴露的 globalThis.__piSessions Map
  const registry = (
    globalThis as { __piSessions?: Map<string, { isAlive(): boolean }> }
  ).__piSessions;
  if (!registry) return 0;
  let count = 0;
  for (const session of registry.values()) {
    if (session.isAlive()) count++;
  }
  return count;
}

/**
 * 获取内存使用情况
 *
 * 不使用 heapTotal（V8 已 commit 的堆，会随使用增长导致比例漂移），
 * 改用硬编码的绝对上限 MEMORY_HARD_LIMIT_MB = 1.5GB。
 * RSS 比 heapUsed 更能反映实际占用，包含 native + JS 堆。
 */
function getMemoryUsage(): { usedMb: number; limitMb: number } {
  const memUsage = process.memoryUsage();
  const usedMb = Math.round(memUsage.rss / 1024 / 1024);
  return { usedMb, limitMb: MEMORY_HARD_LIMIT_MB };
}

/**
 * 完整 readiness 检查
 */
export async function runReadinessChecks(): Promise<HealthCheckResult> {
  const start = Date.now();
  const result: HealthCheckResult = {
    ok: true,
    latencyMs: 0,
    checks: {
      sessions_dir_writable: false,
      plan_states_dir_writable: false,
      bookings_dir_writable: false,
      user_profiles_dir_writable: false,
      memory_under_threshold: false,
    },
  };

  try {
    // 并行检查所有目录（加速）
    const dirChecks = await Promise.all(
      REQUIRED_DIRS.map((name) => checkDirWritable(path.join(PI_AGENT_DIR, name))),
    );
    result.checks.sessions_dir_writable = dirChecks[0];
    result.checks.plan_states_dir_writable = dirChecks[1];
    result.checks.bookings_dir_writable = dirChecks[2];
    result.checks.user_profiles_dir_writable = dirChecks[3];

    // 内存检查
    const mem = getMemoryUsage();
    result.checks.memory_under_threshold =
      mem.usedMb / mem.limitMb < MEMORY_THRESHOLD_PERCENT;

    // 计算整体 ok 状态
    result.ok = Object.values(result.checks).every(Boolean);

    // 详细信息（即使失败也返回，便于调试）
    result.details = {
      memoryUsedMb: mem.usedMb,
      memoryLimitMb: mem.limitMb,
      activeSessions: getActiveSessionCount(),
    };
  } catch (e) {
    result.ok = false;
    result.error = e instanceof Error ? e.message : String(e);
  }

  result.latencyMs = Date.now() - start;
  return result;
}

/**
 * 简单 liveness 检查（只确认进程存活）
 */
export interface LivenessResult {
  status: "ok";
  uptime: number;
  version: string;
  timestamp: string;
}

export function runLivenessCheck(): LivenessResult {
  return {
    status: "ok",
    uptime: Math.round(process.uptime()),
    version: process.env.npm_package_version ?? "0.2.0",
    timestamp: new Date().toISOString(),
  };
}
