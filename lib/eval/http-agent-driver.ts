import type { CapturedIntent, PlanPhase, ProposedPlan } from "../plan-state";
import type {
  EvalAgentCommand,
  EvalAgentDriver,
  EvalAgentTurn,
  EvalStateSnapshot,
  EvalTarget,
  EvalTraceEvent,
} from "./types";

interface SessionMessage {
  role?: string;
  content?: string | Array<Record<string, unknown>>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
}

interface RawPlanState {
  phase: PlanPhase;
  turnCount: number;
  clarificationCount: number;
  intent?: CapturedIntent;
  plan?: ProposedPlan | null;
  pendingClarification?: {
    id: string;
    status: "pending" | "answered" | "expired";
    questions?: Array<{ id: string; field: string }>;
  };
  history?: Array<{ phase: PlanPhase; at: number; reason?: string }>;
}

export interface HttpAgentDriverOptions {
  baseUrl: string;
  cwd: string;
  target: EvalTarget;
  userId?: string;
  timeoutMs?: number;
  cleanupSession?: boolean;
}

function textFromContent(content: SessionMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("");
}

function resultFromMessage(message: SessionMessage): unknown {
  if (message.details !== undefined) return message.details;
  const text = textFromContent(message.content);
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

function toState(state: RawPlanState): EvalStateSnapshot {
  return {
    phase: state.phase,
    turnCount: state.turnCount,
    clarificationCount: state.clarificationCount,
    intent: state.intent,
    plan: state.plan ?? undefined,
    pendingClarification: state.pendingClarification
      ? {
          id: state.pendingClarification.id,
          status: state.pendingClarification.status,
          questions: state.pendingClarification.questions,
        }
      : undefined,
  };
}

export class HttpAgentDriver implements EvalAgentDriver {
  readonly target: EvalTarget;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly cleanupSession: boolean;
  private sessionId?: string;
  private messageCursor = 0;
  private historyCursor = 0;

  constructor(private readonly options: HttpAgentDriverOptions) {
    this.target = options.target;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.cleanupSession = options.cleanupSession !== false;
    this.headers = {
      "Content-Type": "application/json",
      ...(options.userId ? { "X-User-Id": options.userId } : {}),
    };
  }

  async start(initialMessage: string): Promise<EvalAgentTurn> {
    if (this.sessionId) throw new Error("HTTP Agent driver has already started");
    const response = await this.request("/api/agent/new", {
      method: "POST",
      body: JSON.stringify({
        type: "prompt",
        cwd: this.options.cwd,
        message: initialMessage,
        provider: this.target.provider,
        modelId: this.target.modelId,
      }),
    });
    const body = await response.json() as { sessionId?: string };
    if (!body.sessionId) throw new Error("Agent create response did not include sessionId");
    this.sessionId = body.sessionId;
    return this.readCompletedTurn();
  }

  async send(command: EvalAgentCommand): Promise<EvalAgentTurn> {
    if (!this.sessionId) throw new Error("HTTP Agent driver has not started");
    await this.request(`/api/agent/${encodeURIComponent(this.sessionId)}`, {
      method: "POST",
      body: JSON.stringify(command),
    });
    return this.readCompletedTurn();
  }

  async close(): Promise<void> {
    if (!this.sessionId || !this.cleanupSession) return;
    try {
      await fetch(`${this.options.baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}`, {
        method: "DELETE",
        headers: this.headers,
        signal: AbortSignal.timeout(10_000),
      });
    } finally {
      this.sessionId = undefined;
    }
  }

  private async readCompletedTurn(): Promise<EvalAgentTurn> {
    if (!this.sessionId) throw new Error("HTTP Agent driver has no active session");
    await this.waitForIdle();
    const [sessionResponse, stateResponse] = await Promise.all([
      this.request(`/api/sessions/${encodeURIComponent(this.sessionId)}`, { method: "GET" }),
      this.request(`/api/plan-state/${encodeURIComponent(this.sessionId)}`, { method: "GET" }),
    ]);
    const sessionBody = await sessionResponse.json() as {
      context?: { messages?: SessionMessage[] };
    };
    const rawState = await stateResponse.json() as RawPlanState;
    const messages = sessionBody.context?.messages ?? [];
    const freshMessages = messages.slice(this.messageCursor);
    this.messageCursor = messages.length;
    const events = this.messagesToEvents(freshMessages, rawState.phase);
    const history = rawState.history ?? [];
    for (const item of history.slice(this.historyCursor)) {
      events.push({
        at: new Date(item.at).toISOString(),
        type: "phase_change",
        phase: item.phase,
        message: item.reason,
      });
    }
    this.historyCursor = history.length;
    return { events, state: toState(rawState) };
  }

  private messagesToEvents(
    messages: SessionMessage[],
    phase: PlanPhase,
  ): Omit<EvalTraceEvent, "sequence">[] {
    const events: Omit<EvalTraceEvent, "sequence">[] = [];
    for (const message of messages) {
      const at = new Date(message.timestamp ?? Date.now()).toISOString();
      if (message.role === "assistant") {
        const text = textFromContent(message.content);
        if (text) events.push({ at, type: "assistant_message", message: text, phase });
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type !== "toolCall" || typeof block.toolName !== "string") continue;
            events.push({
              at,
              type: "tool_start",
              phase,
              toolName: block.toolName,
              toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : undefined,
              args: block.input,
            });
          }
        }
        if (message.stopReason === "error") {
          events.push({
            at,
            type: "error",
            phase,
            message: message.errorMessage ?? "Assistant turn failed",
          });
        }
      } else if (message.role === "toolResult") {
        events.push({
          at,
          type: "tool_end",
          phase,
          toolName: message.toolName,
          toolCallId: message.toolCallId,
          result: resultFromMessage(message),
          ok: message.isError !== true,
        });
      }
    }
    return events;
  }

  private async waitForIdle(): Promise<void> {
    if (!this.sessionId) return;
    const started = Date.now();
    while (Date.now() - started < this.timeoutMs) {
      const response = await fetch(
        `${this.options.baseUrl}/api/agent/${encodeURIComponent(this.sessionId)}`,
        {
          headers: this.headers,
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (response.ok) {
        const body = await response.json() as {
          running?: boolean;
          state?: { isStreaming?: boolean; isCompacting?: boolean };
        };
        if (!body.running || !body.state?.isStreaming && !body.state?.isCompacting) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Agent session ${this.sessionId} did not become idle within ${this.timeoutMs}ms`);
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const response = await fetch(`${this.options.baseUrl}${pathname}`, {
      ...init,
      headers: { ...this.headers, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${pathname} returned ${response.status}: ${await response.text()}`);
    }
    return response;
  }
}
