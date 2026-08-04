import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { metrics } from "./metrics-registry";

export type ToolExecutionStatus = "success" | "error" | "fallback";

export interface ToolExecutionSpan {
  schemaVersion: 1;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: ToolExecutionStatus;
  isError: boolean;
  fallbackUsed: boolean;
  orphanEnd: boolean;
}

interface ActiveToolExecution {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  startedWallMs: number;
  startedMonotonicMs: number;
}

export interface ToolTelemetryClock {
  wallNow(): number;
  monotonicNow(): number;
}

const SYSTEM_CLOCK: ToolTelemetryClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
};

/**
 * Correlates SDK tool_execution_start/end events by session + tool-call ID.
 * A monotonic clock supplies the duration; wall time is only used for timestamps.
 */
export class ToolTelemetryRecorder {
  private readonly active = new Map<string, ActiveToolExecution>();

  constructor(private readonly clock: ToolTelemetryClock = SYSTEM_CLOCK) {}

  start(sessionId: string, toolCallId: string, toolName: string): void {
    this.active.set(this.key(sessionId, toolCallId), {
      sessionId,
      toolCallId,
      toolName,
      startedWallMs: this.clock.wallNow(),
      startedMonotonicMs: this.clock.monotonicNow(),
    });
  }

  finish(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    options: { isError?: boolean; fallbackUsed?: boolean } = {},
  ): ToolExecutionSpan {
    const endedWallMs = this.clock.wallNow();
    const endedMonotonicMs = this.clock.monotonicNow();
    const key = this.key(sessionId, toolCallId);
    const started = this.active.get(key);
    this.active.delete(key);

    const isError = options.isError === true;
    const fallbackUsed = !isError && options.fallbackUsed === true;
    const durationMs = started
      ? Math.max(0, endedMonotonicMs - started.startedMonotonicMs)
      : 0;

    return {
      schemaVersion: 1,
      sessionId,
      toolCallId,
      toolName: started?.toolName ?? toolName,
      startedAt: new Date(started?.startedWallMs ?? endedWallMs).toISOString(),
      endedAt: new Date(endedWallMs).toISOString(),
      durationMs: Math.round(durationMs * 1000) / 1000,
      status: isError ? "error" : fallbackUsed ? "fallback" : "success",
      isError,
      fallbackUsed,
      orphanEnd: !started,
    };
  }

  get activeCount(): number {
    return this.active.size;
  }

  private key(sessionId: string, toolCallId: string): string {
    return `${sessionId}\u0000${toolCallId}`;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __activityToolTelemetryRecorder: ToolTelemetryRecorder | undefined;
}

export const toolTelemetryRecorder =
  globalThis.__activityToolTelemetryRecorder ?? new ToolTelemetryRecorder();
globalThis.__activityToolTelemetryRecorder = toolTelemetryRecorder;

export function getToolSpanDirectory(): string {
  return process.env.TOOL_SPAN_DIR?.trim()
    || path.join(os.homedir(), ".pi", "agent", "tool-spans");
}

export async function persistToolExecutionSpan(span: ToolExecutionSpan): Promise<void> {
  try {
    const directory = getToolSpanDirectory();
    await mkdir(directory, { recursive: true });
    const day = span.endedAt.slice(0, 10).replaceAll("-", "");
    await appendFile(path.join(directory, `${day}.jsonl`), `${JSON.stringify(span)}\n`, "utf8");
    metrics.inc("tool_span_total", { tool: span.toolName, status: span.status });
    metrics.observe("tool_duration_seconds", span.durationMs / 1000, {
      tool: span.toolName,
      status: span.status,
    });
    if (span.orphanEnd) metrics.inc("tool_span_orphan_total");
  } catch (error) {
    metrics.inc("tool_span_persist_failure_total");
    console.warn("[tool-telemetry] failed to persist span", error);
  }
}

export async function listToolExecutionSpans(options: {
  sessionId?: string;
  limit?: number;
} = {}): Promise<ToolExecutionSpan[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 2_000, 10_000));
  const directory = getToolSpanDirectory();
  let files: string[];
  try {
    files = (await readdir(directory))
      .filter((file) => /^\d{8}\.jsonl$/.test(file))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const spans: ToolExecutionSpan[] = [];
  for (const file of files) {
    const content = await readFile(path.join(directory, file), "utf8");
    const lines = content.trim().split("\n").reverse();
    for (const line of lines) {
      if (!line) continue;
      try {
        const span = JSON.parse(line) as ToolExecutionSpan;
        if (span.schemaVersion !== 1) continue;
        if (options.sessionId && span.sessionId !== options.sessionId) continue;
        spans.push(span);
        if (spans.length >= limit) return spans.reverse();
      } catch {
        // A partial/corrupt JSONL line must not make telemetry unreadable.
      }
    }
  }
  return spans.reverse();
}

export function resultUsedFallback(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  const details = record.details;
  if (details && typeof details === "object" && (details as Record<string, unknown>).fallback === true) {
    return true;
  }
  const content = record.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const text = (block as Record<string, unknown>).text;
    if (typeof text !== "string" || !text.includes('"fallback"')) return false;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return parsed.fallback === true;
    } catch {
      return false;
    }
  });
}
