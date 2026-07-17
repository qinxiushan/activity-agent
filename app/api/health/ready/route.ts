/**
 * Readiness Endpoint - /api/health/ready
 *
 * 用于 K8s readinessProbe：
 * - 检查进程是否准备好接收流量
 * - 检查所有依赖（文件目录可写、内存未满）
 * - 失败时 K8s 会从 Service Endpoints 摘除该 Pod
 *
 * 行为：
 * - 所有检查通过：200 + { status: "ready", checks, details }
 * - 任一检查失败：503 + { status: "not_ready", checks, error? }
 *
 * 检查项（阶段 1，文件存储）：
 * 1. sessions 目录可写（pi session JSONL）
 * 2. plan-states 目录可写（SOP 状态机）
 * 3. bookings 目录可写（订单）
 * 4. user-profiles 目录可写（用户偏好）
 * 5. 内存使用 < 90%
 *
 * 阶段 2 升级：会新增 PG/Redis 连接检查
 */

import { NextResponse } from "next/server";
import { runReadinessChecks } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const result = await runReadinessChecks();
  return NextResponse.json(
    {
      status: result.ok ? "ready" : "not_ready",
      latencyMs: result.latencyMs,
      checks: result.checks,
      details: result.details,
      error: result.error,
    },
    { status: result.ok ? 200 : 503 },
  );
}
