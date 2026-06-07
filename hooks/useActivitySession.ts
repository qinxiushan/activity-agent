"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ActivityToolCall {
  id: string;
  name: string;
  argsSummary: string;
  resultSummary: string;
  ok: boolean;
  startedAt: number;
  endedAt: number | null;
}

export interface ActivityPlanState {
  phase: string;
  turnCount: number;
  clarificationCount: number;
  intent: Record<string, unknown>;
  plan: {
    summary: string;
    timeline: Array<{ startTime: string; endTime: string; type: string; poiName?: string; notes?: string }>;
    totalCost: number;
    totalDurationMinutes: number;
    weather: { city: string; date: string; condition: string; tempMax: number; tempMin: number; advice: string };
  } | null;
  history: Array<{ phase: string; at: number; reason?: string }>;
}

export interface ActivityMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolNames?: string[];
}

export interface ActivityState {
  sessionId: string | null;
  agentRunning: boolean;
  messages: ActivityMessage[];
  toolCalls: ActivityToolCall[];
  planState: ActivityPlanState | null;
  error: string | null;
}

const INITIAL: ActivityState = {
  sessionId: null,
  agentRunning: false,
  messages: [],
  toolCalls: [],
  planState: null,
  error: null,
};

interface RawEvent {
  type: string;
  [k: string]: unknown;
}

function summarizeArgs(args: unknown, max = 80): string {
  if (args === undefined || args === null) return "";
  const s = typeof args === "string" ? args : JSON.stringify(args);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function summarizeResult(result: unknown, max = 80): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result.length > max ? result.slice(0, max) + "…" : result;
  try {
    const s = JSON.stringify(result);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(result).slice(0, max);
  }
}

export interface UseActivitySessionResult extends ActivityState {
  startSession: (cwd: string, message: string, model: { provider: string; modelId: string }) => Promise<void>;
  sendMessage: (message: string) => Promise<void>;
  reset: () => void;
}

export function useActivitySession(serverBase = ""): UseActivitySessionResult {
  const [state, setState] = useState<ActivityState>(INITIAL);
  const esRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const planPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightSendRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPlanPoll = useCallback(() => {
    if (planPollRef.current) {
      clearInterval(planPollRef.current);
      planPollRef.current = null;
    }
  }, []);

  const cancelReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const startPlanPoll = useCallback((sid: string) => {
    stopPlanPoll();
    const fetchOnce = async (): Promise<void> => {
      try {
        const r = await fetch(`${serverBase}/api/plan-state/${encodeURIComponent(sid)}`, { cache: "no-store" });
        if (r.ok) {
          const d = (await r.json()) as ActivityPlanState;
          setState((prev) => (prev.planState?.phase === d.phase && prev.planState?.turnCount === d.turnCount
            ? prev
            : { ...prev, planState: d }));
        }
      } catch { /* ignore */ }
    };
    void fetchOnce();
    planPollRef.current = setInterval(() => { void fetchOnce(); }, 1500);
  }, [serverBase, stopPlanPoll]);

  const connectEvents = useCallback((sid: string) => {
    cancelReconnect();
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    reconnectAttemptsRef.current = 0;

    const connect = (): void => {
      if (sessionIdRef.current !== sid) return;
      const es = new EventSource(`${serverBase}/api/agent/${encodeURIComponent(sid)}/events`);
      esRef.current = es;
      es.onopen = () => { reconnectAttemptsRef.current = 0; };
      es.onmessage = (e) => {
        reconnectAttemptsRef.current = 0;
        let ev: RawEvent;
        try { ev = JSON.parse(e.data) as RawEvent; } catch { return; }
        switch (ev.type) {
          case "agent_start":
            setState((prev) => ({ ...prev, agentRunning: true }));
            break;
          case "agent_end":
            setState((prev) => ({ ...prev, agentRunning: false }));
            break;
          case "message_end": {
            const m = ev.message as { role?: string; content?: Array<{ type: string; text?: string }> } | undefined;
            if (!m) return;
            let text = "";
            if (typeof m.content === "string") text = m.content;
            else if (Array.isArray(m.content)) {
              text = m.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text ?? "").join("");
            }
            if (!text && m.role !== "user") return;
            setState((prev) => {
              const last = prev.messages[prev.messages.length - 1];
              if (last && last.role === m.role && Math.abs(last.timestamp - (ev.timestamp as number ?? Date.now())) < 200) {
                return { ...prev, messages: [...prev.messages.slice(0, -1), { ...last, content: last.content + text }] };
              }
              return { ...prev, messages: [...prev.messages, { role: (m.role as "user" | "assistant") ?? "assistant", content: text, timestamp: Date.now() }] };
            });
            break;
          }
          case "tool_execution_start": {
            const id = (ev.toolCallId as string) ?? Math.random().toString(36).slice(2);
            const name = (ev.toolName as string) ?? "?";
            const args = ev.args;
            const tc: ActivityToolCall = {
              id, name,
              argsSummary: summarizeArgs(args),
              resultSummary: "",
              ok: true,
              startedAt: Date.now(),
              endedAt: null,
            };
            setState((prev) => ({ ...prev, toolCalls: [...prev.toolCalls, tc] }));
            break;
          }
          case "tool_execution_end": {
            const id = (ev.toolCallId as string) ?? "";
            const result = ev.result;
            const isError = ev.isError === true;
            setState((prev) => ({
              ...prev,
              toolCalls: prev.toolCalls.map((t) => t.id === id
                ? { ...t, ok: !isError, resultSummary: summarizeResult(result), endedAt: Date.now() }
                : t),
            }));
            break;
          }
        }
      };
      es.onerror = () => {
        if (esRef.current !== es) return;
        if (sessionIdRef.current !== sid) return;
        es.close();
        esRef.current = null;
        const attempt = reconnectAttemptsRef.current++;
        const delayMs = Math.min(1000 * 2 ** attempt, 30_000);
        reconnectTimerRef.current = setTimeout(connect, delayMs);
      };
    };

    connect();
  }, [serverBase, cancelReconnect]);

  useEffect(() => {
    return () => {
      cancelReconnect();
      esRef.current?.close();
      stopPlanPoll();
    };
  }, [stopPlanPoll, cancelReconnect]);

  const startSession = useCallback(async (cwd: string, message: string, model: { provider: string; modelId: string }) => {
    setState({ ...INITIAL, error: null });
    try {
      const res = await fetch(`${serverBase}/api/agent/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, type: "prompt", message, provider: model.provider, modelId: model.modelId }),
      });
      if (!res.ok) throw new Error(`create failed: HTTP ${res.status}`);
      const { sessionId } = (await res.json()) as { sessionId: string };
      sessionIdRef.current = sessionId;
      setState((prev) => ({ ...prev, sessionId }));
      connectEvents(sessionId);
      startPlanPoll(sessionId);
    } catch (e) {
      setState((prev) => ({ ...prev, error: (e as Error).message }));
    }
  }, [serverBase, connectEvents, startPlanPoll]);

  const sendMessage = useCallback(async (message: string) => {
    if (inFlightSendRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    inFlightSendRef.current = true;
    try {
      await fetch(`${serverBase}/api/agent/${encodeURIComponent(sid)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", message }),
      });
    } catch (e) {
      setState((prev) => ({ ...prev, error: (e as Error).message }));
    } finally {
      inFlightSendRef.current = false;
    }
  }, [serverBase]);

  const reset = useCallback(() => {
    cancelReconnect();
    esRef.current?.close();
    esRef.current = null;
    stopPlanPoll();
    sessionIdRef.current = null;
    setState(INITIAL);
  }, [stopPlanPoll, cancelReconnect]);

  return { ...state, startSession, sendMessage, reset };
}
