/**
 * StandardEvent - 前端友好的事件 schema
 *
 * 设计目标：解耦前端与 pi SDK 内部事件 schema。
 * EventAdapter (lib/event-adapter.ts) 把 pi AgentEvent 映射为这些类型，
 * 前端只依赖 StandardEvent，不关心底层 SDK 是什么。
 *
 * 11 种事件类型：
 * 1.  agent_start       Agent 开始处理消息
 * 2.  turn_start        LLM turn 开始
 * 3.  text_delta        文本流式 chunk
 * 4.  thinking_delta    思维链流式 chunk
 * 5.  tool_start        工具调用开始
 * 6.  tool_end          工具调用完成
 * 7.  tool_error        工具调用失败
 * 8.  turn_end          turn 完成（含 usage）
 * 9.  system            系统事件（compaction/retry/session_recovered）
 * 10. error             错误
 * 11. done              agent 完全结束
 *
 * 与 pi SDK 事件映射（详见 lib/event-adapter.ts）：
 * - agent_start   ← pi agent_start
 * - turn_start    ← pi turn_start
 * - text_delta    ← pi message_update.assistantMessageEvent.text_delta.delta
 * - thinking_delta← pi message_update.assistantMessageEvent.thinking_delta.delta
 * - tool_start    ← pi tool_execution_start
 * - tool_end      ← pi tool_execution_end (isError=false)
 * - tool_error    ← pi tool_execution_end (isError=true)
 * - turn_end      ← pi turn_end
 * - system        ← pi auto_retry_* / auto_compaction_* / compaction_*
 * - error         ← pi message_end.stopReason=error (curated)
 * - done          ← pi agent_end
 */

export type StandardEvent =
  | { type: "agent_start"; sessionId: string }
  | { type: "turn_start"; turnIndex: number }
  | { type: "text_delta"; text: string; turnIndex: number }
  | { type: "thinking_delta"; text: string; turnIndex: number }
  | { type: "tool_start"; toolName: string; toolCallId: string; args: unknown }
  | {
      type: "tool_end";
      toolName: string;
      toolCallId: string;
      isError: boolean;
      durationMs: number;
    }
  | {
      type: "turn_end";
      turnIndex: number;
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
      };
      stopReason: string;
      message?: unknown;
    }
  | {
      type: "system";
      subtype: "compaction" | "retry" | "session_recovered";
      message: string;
      [key: string]: unknown;
    }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
    }
  | {
      type: "done";
      sessionId: string;
      totalTurns: number;
      totalCost: number;
      message?: unknown;
    }
  | {
      type: "message_added";
      message: unknown;
      role: "user" | "assistant" | "toolResult";
    };

export type StandardEventType = StandardEvent["type"];

export function isStandardEvent(value: unknown): value is StandardEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "agent_start" ||
    type === "turn_start" ||
    type === "text_delta" ||
    type === "thinking_delta" ||
    type === "tool_start" ||
    type === "tool_end" ||
    type === "turn_end" ||
    type === "system" ||
    type === "error" ||
    type === "done" ||
    type === "message_added"
  );
}
