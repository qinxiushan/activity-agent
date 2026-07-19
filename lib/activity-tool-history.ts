import type { AgentMessage, AssistantMessage, ToolResultMessage, ToolCallContent, TextContent } from "./types";

export interface HistoricalActivityToolCall {
  id: string;
  name: string;
  argsSummary: string;
  resultSummary: string;
  result: unknown;
  ok: boolean;
  startedAt: number;
  endedAt: number | null;
}

function summarize(value: unknown, max = 80): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.length > max ? value.slice(0, max) + "…" : value;
  try {
    const text = JSON.stringify(value);
    return text.length > max ? text.slice(0, max) + "…" : text;
  } catch {
    return String(value).slice(0, max);
  }
}

function extractToolCalls(msg: AssistantMessage): ToolCallContent[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((block): block is ToolCallContent => block.type === "toolCall");
}

function extractTextContent(content: ToolResultMessage["content"]): string {
  return content
    .filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function parseToolResult(msg: ToolResultMessage): unknown {
  if (msg.details !== undefined) return msg.details;
  const text = extractTextContent(msg.content);
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function restoreActivityToolCallsFromMessages(messages: AgentMessage[]): HistoricalActivityToolCall[] {
  const restored: HistoricalActivityToolCall[] = [];
  const byId = new Map<string, number>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const assistant = msg as AssistantMessage;
      const startedAt = assistant.timestamp ?? Date.now();
      for (const toolCall of extractToolCalls(assistant)) {
        const next: HistoricalActivityToolCall = {
          id: toolCall.toolCallId,
          name: toolCall.toolName,
          argsSummary: summarize(toolCall.input),
          resultSummary: "",
          result: undefined,
          ok: true,
          startedAt,
          endedAt: null,
        };
        byId.set(next.id, restored.length);
        restored.push(next);
      }
      continue;
    }

    if (msg.role !== "toolResult") continue;
    const toolResult = msg as ToolResultMessage;
    const result = parseToolResult(toolResult);
    const endedAt = toolResult.timestamp ?? Date.now();
    const idx = byId.get(toolResult.toolCallId);
    if (idx === undefined) {
      const synthetic: HistoricalActivityToolCall = {
        id: toolResult.toolCallId,
        name: toolResult.toolName ?? "unknown_tool",
        argsSummary: "",
        resultSummary: summarize(result),
        result,
        ok: toolResult.isError !== true,
        startedAt: endedAt,
        endedAt,
      };
      byId.set(synthetic.id, restored.length);
      restored.push(synthetic);
      continue;
    }

    const current = restored[idx]!;
    restored[idx] = {
      ...current,
      ok: toolResult.isError !== true,
      endedAt,
      result,
      resultSummary: summarize(result),
    };
  }

  return restored;
}
