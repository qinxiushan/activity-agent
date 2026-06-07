"use client";

import { useState } from "react";
import { ActivityPanel } from "@/components/activity/ActivityPanel";
import { UserPreferencesPanel } from "@/components/UserPreferencesPanel";
import type { ActivityPlanState, ActivityToolCall } from "@/hooks/useActivitySession";

interface Props {
  sessionId: string | null;
  planState: ActivityPlanState | null;
  toolCalls: ActivityToolCall[];
  planStateError: string | null;
  sseReconnecting: boolean;
  error: string | null;
  agentRunning: boolean;
  reset: () => void;
  abort: () => Promise<void>;
  retryPlanPoll: () => Promise<void>;
}

export function ActivityPanelWrapper({
  sessionId,
  planState,
  toolCalls,
  planStateError,
  sseReconnecting,
  error,
  agentRunning,
  reset,
  abort,
  retryPlanPoll,
}: Props) {
  const [aborting, setAborting] = useState(false);

  const handleAbort = async () => {
    if (aborting) return;
    setAborting(true);
    try {
      await abort();
    } finally {
      setAborting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header — status badges only */}
      <div style={{
        padding: "10px 14px", borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <div style={{
          fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 600,
        }}>
          Status
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          {sessionId && (
            <button
              onClick={reset}
              title="丢弃当前会话"
              style={{
                background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
                padding: "2px 8px", borderRadius: 6, fontSize: 10, cursor: "pointer",
              }}
            >新会话</button>
          )}
          {agentRunning && (
            <>
              <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--accent)" }}>
                <span style={{
                  width: 5, height: 5, borderRadius: "50%", background: "var(--accent)",
                  animation: "pulse 1.5s infinite",
                }} />
                LLM 工作中
              </span>
              <button
                onClick={handleAbort}
                disabled={aborting}
                title="停止当前 LLM 任务"
                style={{
                  background: "none", border: "1px solid var(--border)",
                  color: aborting ? "var(--text-dim)" : "#ef4444",
                  padding: "2px 8px", borderRadius: 6, fontSize: 10,
                  cursor: aborting ? "default" : "pointer",
                }}
              >{aborting ? "停止中" : "停止"}</button>
            </>
          )}
          {sseReconnecting && (
            <span
              title="SSE 连接断开,正在重连…"
              style={{
                display: "flex", alignItems: "center", gap: 5, fontSize: 10,
                color: "rgba(234,179,8,0.95)",
              }}
            >
              <span style={{
                width: 5, height: 5, borderRadius: "50%",
                background: "rgba(234,179,8,0.95)",
                animation: "pulse 1.5s infinite",
              }} />
              正在重连…
            </span>
          )}
        </div>
      </div>

      {/* Status content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px" }}>
        {error && (
          <div style={{
            padding: "8px 10px", marginBottom: 10,
            color: "#ef4444", background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 6, fontSize: 11,
          }}>
            错误: {error}
          </div>
        )}
        {planStateError && (
          <div style={{
            padding: "6px 10px", marginBottom: 10,
            color: "#ef4444", background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: 6, fontSize: 10,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span style={{ flex: 1 }}>{planStateError}</span>
            <button
              onClick={() => void retryPlanPoll()}
              title="立即重试 plan-state 请求"
              style={{
                background: "none", border: "1px solid rgba(239,68,68,0.4)",
                color: "#ef4444", padding: "1px 8px", borderRadius: 4, fontSize: 10,
                cursor: "pointer", flexShrink: 0,
              }}
            >重试</button>
          </div>
        )}
        {!sessionId && (
          <div style={{ textAlign: "center", color: "var(--text-dim)", padding: "32px 12px" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>等待活动开始</div>
            <div style={{ fontSize: 10 }}>在中间栏输入需求,此处显示 SOP 阶段、工具调用、方案时间线</div>
          </div>
        )}
        <UserPreferencesPanel />
        <ActivityPanel planState={planState} toolCalls={toolCalls} />
      </div>
    </div>
  );
}
