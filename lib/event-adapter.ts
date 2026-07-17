/**
 * EventAdapter - pi SDK AgentEvent → StandardEvent 映射层
 *
 * 解决问题（docs/pi-agent-design-analysis.md §2.2 + §6.4）：
 * - 活动 agent 之前直接透传 pi 内部事件（message_update / tool_execution_start 等）
 *   到前端，前端需要理解 pi SDK 内部事件 schema
 * - 换 SDK 时前端必须改
 * - 与 docs/web-integration 标准化事件协议脱节
 *
 * 解决方案：
 * - EventAdapter 把 pi AgentEvent 映射为 11 种 StandardEvent
 * - 前端只依赖 StandardEvent，底层 SDK 可替换
 * - 同时注入 plan state 上下文（currentPhase / turnCount）便于前端业务化展示
 *
 * 设计要点：
 * - 状态由 adapter 维护（turnIndex / toolStartTimes / planState）
 * - 不抛异常（pi 事件 schema 漂移时静默忽略未知字段）
 * - 不修改原 piEvent 引用（纯函数式转换）
 */

import type { PlanStateManager } from "./plan-state";
import type { StandardEvent } from "./event-types";

interface PiAgentEvent {
  type: string;
  [key: string]: unknown;
}

interface PiAssistantMessageEvent {
  type: string;
  delta?: string;
  contentIndex?: number;
  partial?: { usage?: PiUsage; stopReason?: string };
}

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: { total: number };
}

export class EventAdapter {
  private sessionId: string;
  private planState: PlanStateManager | null;
  private turnIndex = 0;
  private toolStartTimes = new Map<string, number>();
  private lastTurnUsage: PiUsage | null = null;
  private totalCost = 0;
  private hasFiredDone = false;

  constructor(sessionId: string, planState: PlanStateManager | null = null) {
    this.sessionId = sessionId;
    this.planState = planState;
  }

  adapt(piEvent: PiAgentEvent): StandardEvent[] {
    if (!piEvent || typeof piEvent.type !== "string") return [];

    switch (piEvent.type) {
      case "agent_start":
        // 重置跨 prompt 状态标志，确保多轮对话中每次 agent 结束都能正常发送 done 事件
        this.hasFiredDone = false;
        return [{ type: "agent_start", sessionId: this.sessionId }];

      case "agent_end":
        if (this.hasFiredDone) return [];
        this.hasFiredDone = true;
        return [
          {
            type: "done",
            sessionId: this.sessionId,
            totalTurns: this.planState?.current?.turnCount ?? this.turnIndex,
            totalCost: this.totalCost,
            message: (piEvent as { messages?: unknown }).messages,
          },
        ];

      case "turn_start":
        this.turnIndex++;
        return [{ type: "turn_start", turnIndex: this.turnIndex }];

      case "turn_end": {
        const message = piEvent.message as { usage?: PiUsage; stopReason?: string } | undefined;
        const usage = message?.usage;
        const stopReason = message?.stopReason ?? "stop";
        if (usage) this.lastTurnUsage = usage;
        if (usage?.cost?.total) this.totalCost += usage.cost.total;
        return [
          {
            type: "turn_end",
            turnIndex: this.turnIndex,
            usage: {
              input: usage?.input ?? 0,
              output: usage?.output ?? 0,
              cacheRead: usage?.cacheRead ?? 0,
              cacheWrite: usage?.cacheWrite ?? 0,
              cost: usage?.cost?.total ?? 0,
            },
            stopReason,
            message: piEvent.message,
          },
        ];
      }

      case "message_update": {
        const inner = piEvent.assistantMessageEvent as PiAssistantMessageEvent | undefined;
        if (!inner) return [];
        if (inner.type === "text_delta" && typeof inner.delta === "string") {
          return [{ type: "text_delta", text: inner.delta, turnIndex: this.turnIndex }];
        }
        if (inner.type === "thinking_delta" && typeof inner.delta === "string") {
          return [{ type: "thinking_delta", text: inner.delta, turnIndex: this.turnIndex }];
        }
        return [];
      }

      case "tool_execution_start": {
        const toolCallId = piEvent.toolCallId as string;
        const toolName = piEvent.toolName as string;
        const args = piEvent.args;
        this.toolStartTimes.set(toolCallId, Date.now());
        return [{ type: "tool_start", toolName, toolCallId, args }];
      }

      case "tool_execution_end": {
        const toolCallId = piEvent.toolCallId as string;
        const toolName = piEvent.toolName as string;
        const isError = piEvent.isError === true;
        const start = this.toolStartTimes.get(toolCallId) ?? Date.now();
        this.toolStartTimes.delete(toolCallId);
        return [
          {
            type: "tool_end",
            toolName,
            toolCallId,
            isError,
            durationMs: Date.now() - start,
          },
        ];
      }

      case "auto_retry_start":
        return [
          {
            type: "system",
            subtype: "retry",
            message: `Retry attempt ${piEvent.attempt}/${piEvent.maxAttempts}: ${piEvent.errorMessage ?? "unknown error"}`,
            attempt: piEvent.attempt,
            maxAttempts: piEvent.maxAttempts,
            errorMessage: piEvent.errorMessage,
          },
        ];

      case "auto_retry_end":
        return [
          {
            type: "system",
            subtype: "retry",
            message: piEvent.success ? "Retry succeeded" : "Retry failed",
            attempt: piEvent.attempt,
            success: piEvent.success,
          },
        ];

      case "auto_compaction_start":
      case "compaction_start":
        return [
          {
            type: "system",
            subtype: "compaction",
            message: "Compaction in progress",
          },
        ];

      case "auto_compaction_end":
      case "compaction_end":
        return [
          {
            type: "system",
            subtype: "compaction",
            message: "Compaction complete",
            savedTokens: piEvent.savedTokens,
          },
        ];

      case "session_recovered":
        return [
          {
            type: "system",
            subtype: "session_recovered",
            message: "Session recovered",
            recoveredFrom: piEvent.recoveredFrom,
          },
        ];

      case "message_end": {
        const message = piEvent.message as { stopReason?: string; errorMessage?: string; role?: string } | undefined;
        const events: StandardEvent[] = [];
        if (message) {
          events.push({
            type: "message_added",
            message,
            role: (message.role as "user" | "assistant" | "toolResult") ?? "assistant",
          });
        }
        if (message?.stopReason === "error" && message.errorMessage) {
          events.push({
            type: "error",
            code: "LLM_ERROR",
            message: message.errorMessage,
            retryable: true,
          });
        }
        return events;
      }

      default:
        return [];
    }
  }

  reset(): void {
    this.turnIndex = 0;
    this.toolStartTimes.clear();
    this.lastTurnUsage = null;
    this.totalCost = 0;
    this.hasFiredDone = false;
  }
}
