/**
 * Tool Wrapper - 通用工具重试、降级、包装层
 *
 * 解决问题（PRD P0-4）：
 * - 当前所有工具 execute() 无 try/catch，任何异常冒泡到 AgentSession
 * - 无自动重试：API 超时/瞬时故障直接失败
 * - 无降级路径：核心数据源不可用 = 用户看到 500 错误
 *
 * 设计原则：
 * - 包装而非侵入：原始 ToolDefinition 不变，通过 wrapper 增强
 * - 可配置：每个工具可以独立配置 retry 策略和 fallback
 * - 可观测：记录每次执行耗时、结果、重试次数
 * - 类型安全：完整保留 TypeBox 参数 schema 和返回类型
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// ─── 类型定义 ──────────────────────────────────────────────────────

export interface RetryConfig {
  /** 最大重试次数（不含首次） */
  maxRetries: number;
  /** 退避策略 */
  backoff: "fixed" | "exponential" | "linear";
  /** 基础延迟（ms） */
  baseDelay: number;
  /** 最大延迟（ms） */
  maxDelay: number;
  /** 可重试的异常类型（默认所有） */
  retryableErrors?: (error: Error) => boolean;
}

export interface FallbackHandler {
  /** 当所有重试都失败时调用 */
  (toolName: string, params: unknown, lastError: Error): Promise<ToolResult>;
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

export interface ToolMetrics {
  toolName: string;
  attempts: number;
  totalDurationMs: number;
  success: boolean;
  error?: string;
  fallbackUsed: boolean;
  timestamp: number;
}

export interface WrapOptions {
  retry?: Partial<RetryConfig>;
  fallback?: FallbackHandler;
  timeoutMs?: number;
  onMetric?: (m: ToolMetrics) => void;
  label?: string;
  beforeExecute?: (
    toolName: string,
    params: unknown,
  ) => { allowed: true } | { allowed: false; error: string };
}

// ─── 默认配置 ──────────────────────────────────────────────────────

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 2,
  backoff: "exponential",
  baseDelay: 200,
  maxDelay: 2000,
  retryableErrors: () => true,
};

const DEFAULT_TIMEOUT_MS = 10_000;

// ─── 退避计算 ──────────────────────────────────────────────────────

function computeDelay(attempt: number, cfg: RetryConfig): number {
  let delay: number;
  switch (cfg.backoff) {
    case "exponential":
      delay = cfg.baseDelay * Math.pow(2, attempt);
      break;
    case "linear":
      delay = cfg.baseDelay * (attempt + 1);
      break;
    case "fixed":
    default:
      delay = cfg.baseDelay;
      break;
  }
  return Math.min(delay, cfg.maxDelay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 核心包装函数 ──────────────────────────────────────────────────

/**
 * 用 retry + timeout + fallback 包装一个 ToolDefinition
 */
export function wrapToolWithResilience(
  tool: ToolDefinition,
  opts: WrapOptions = {},
): ToolDefinition {
  const retry: RetryConfig = { ...DEFAULT_RETRY, ...(opts.retry ?? {}) };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = opts.label ?? tool.name;
  const onMetric = opts.onMetric;
  const fallback = opts.fallback;

  return {
    ...tool,
    execute: async (id, params, signal, onUpdate, ctx) => {
      const startTime = Date.now();
      let lastError: Error | undefined;
      let attempts = 0;
      let fallbackUsed = false;

      if (opts.beforeExecute) {
        const guard = opts.beforeExecute(tool.name, params);
        if (!guard.allowed) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: true, code: "PHASE_GUARD", tool: label, message: guard.error }, null, 2),
            }],
            details: { error: true, code: "PHASE_GUARD", message: guard.error },
          };
        }
      }

      for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
        attempts++;
        try {
          // 1. 超时控制（用 Promise.race 实现，因为 pi 的 signal 行为复杂）
          const result = await withTimeout(
            Promise.resolve(tool.execute(id, params, signal, onUpdate, ctx)),
            timeoutMs,
            label,
          );
          // 成功
          onMetric?.({
            toolName: label,
            attempts,
            totalDurationMs: Date.now() - startTime,
            success: true,
            fallbackUsed,
            timestamp: startTime,
          });
          return result;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          // 不在可重试列表？
          if (!retry.retryableErrors!(lastError)) break;
          // 已是最后一次？
          if (attempt < retry.maxRetries) {
            await sleep(computeDelay(attempt, retry));
          }
        }
      }

      // 2. 全部重试失败 → 尝试 fallback
      if (fallback) {
        try {
          const fbResult = await fallback(tool.name, params, lastError!);
          fallbackUsed = true;
          onMetric?.({
            toolName: label,
            attempts,
            totalDurationMs: Date.now() - startTime,
            success: true,
            fallbackUsed,
            timestamp: startTime,
          });
          return fbResult;
        } catch (fbError) {
          // fallback 也失败，合并错误
          lastError = new Error(
            `Tool ${label} failed: ${lastError!.message}; fallback also failed: ${(fbError as Error).message}`,
          );
        }
      }

      // 3. 全部失败 → 返回结构化错误（不抛异常，让 LLM 看到错误信息并继续对话）
      onMetric?.({
        toolName: label,
        attempts,
        totalDurationMs: Date.now() - startTime,
        success: false,
        error: lastError?.message,
        fallbackUsed,
        timestamp: startTime,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                error: true,
                code: "TOOL_EXECUTION_FAILED",
                tool: label,
                message: lastError?.message ?? "Unknown error",
                attempts,
                fallbackAttempted: !!fallback,
                suggestion: "请重试，或修改输入参数",
              },
              null,
              2,
            ),
          },
        ],
        details: { error: true, message: lastError?.message },
      };
    },
  };
}

// ─── 工具函数 ──────────────────────────────────────────────────────

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tool ${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 内存中收集所有工具的 metrics（用于调试/监控）
 */
const metricsBuffer: ToolMetrics[] = [];
const MAX_BUFFER = 200;

export function recordToolMetric(m: ToolMetrics): void {
  metricsBuffer.push(m);
  if (metricsBuffer.length > MAX_BUFFER) metricsBuffer.shift();
}

export function getRecentMetrics(limit = 50): ToolMetrics[] {
  return metricsBuffer.slice(-limit);
}

export function clearMetrics(): void {
  metricsBuffer.length = 0;
}

// ─── 预设策略 ──────────────────────────────────────────────────────

/** 数据查询类：短超时、有限重试、fallback 到空结果 */
export const dataQueryWrapOpts = (fallback?: FallbackHandler): WrapOptions => ({
  retry: { maxRetries: 2, backoff: "exponential", baseDelay: 100, maxDelay: 1000 },
  timeoutMs: 5_000,
  fallback,
  onMetric: recordToolMetric,
});

/** 写操作类（预订）：更长超时、更多重试、必须有 fallback */
export const writeOpWrapOpts = (fallback: FallbackHandler): WrapOptions => ({
  retry: { maxRetries: 3, backoff: "exponential", baseDelay: 300, maxDelay: 3000 },
  timeoutMs: 8_000,
  fallback,
  onMetric: recordToolMetric,
});

/** 持久化类（plan_save/load）：低重试、无 fallback（数据错误是确定的） */
export const persistWrapOpts: WrapOptions = {
  retry: { maxRetries: 1, backoff: "fixed", baseDelay: 100, maxDelay: 500 },
  timeoutMs: 3_000,
  onMetric: recordToolMetric,
};
