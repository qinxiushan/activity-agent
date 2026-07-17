/**
 * Liveness Endpoint - /api/health
 *
 * 用于 K8s livenessProbe：
 * - 只检查进程是否存活
 * - 不做 IO（必须 < 100ms）
 * - 进程在 → 返回 200；进程挂 → 整个 Pod 会被 K8s 杀
 *
 * 行为：
 * - 成功：200 + { status: "ok", uptime, version, timestamp }
 * - 失败：实际不会失败（除非代码崩了）
 */

import { NextResponse } from "next/server";
import { runLivenessCheck } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const result = runLivenessCheck();
  return NextResponse.json(result);
}
