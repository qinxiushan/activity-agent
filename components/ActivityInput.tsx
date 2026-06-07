"use client";

import { useState } from "react";
import type { ActivityMessage } from "@/hooks/useActivitySession";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface Props {
  sessionId: string | null;
  messages: ActivityMessage[];
  agentRunning: boolean;
  error: string | null;
  cwd: string | null;
  model: { provider: string; modelId: string } | null;
  modelList: ModelInfo[];
  onStartSession: (cwd: string, message: string, model: { provider: string; modelId: string }) => Promise<void>;
  onSendMessage: (message: string) => Promise<void>;
  onAbort: () => Promise<void>;
  onModelChange?: (provider: string, modelId: string) => void;
}

function summarizeAssistant(messages: ActivityMessage[]): ActivityMessage[] {
  return messages.filter((m) => m.role === "assistant");
}

export function ActivityInput({
  sessionId,
  messages,
  agentRunning,
  error,
  cwd,
  model,
  modelList,
  onStartSession,
  onSendMessage,
  onAbort,
  onModelChange,
}: Props) {
  const [input, setInput] = useState("");
  const [aborting, setAborting] = useState(false);

  const canStart = !!cwd && !!model && input.trim().length > 0 && !agentRunning;
  const canSend = !!sessionId && input.trim().length > 0 && !agentRunning;
  const actionEnabled = sessionId ? canSend : canStart;

  const handleAction = () => {
    if (!actionEnabled) return;
    if (sessionId) {
      void onSendMessage(input);
    } else {
      if (!cwd || !model) return;
      void onStartSession(cwd, input, model);
    }
    setInput("");
  };

  const handleAbort = async () => {
    if (aborting) return;
    setAborting(true);
    try {
      await onAbort();
    } finally {
      setAborting(false);
    }
  };

  const hasSession = !!sessionId;
  const summaries = summarizeAssistant(messages);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Messages area */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
        {!hasSession && (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", height: "100%", color: "var(--text-dim)",
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
              活动规划
            </div>
            <div style={{ fontSize: 12, maxWidth: 320, textAlign: "center", lineHeight: 1.6 }}>
              在下方输入需求，AI 自动查询天气、搜索活动、计算路线，生成完整方案后等你确认。
            </div>
          </div>
        )}

        {/* Errors */}
        {error && (
          <div style={{
            padding: "10px 14px", marginBottom: 12,
            color: "#ef4444", background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8, fontSize: 12,
          }}>
            错误: {error}
          </div>
        )}

        {/* Agent running indicator */}
        {agentRunning && (
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            marginBottom: 12, fontSize: 12, color: "var(--accent)",
          }}>
            <span style={{
              width: 5, height: 5, borderRadius: "50%",
              background: "var(--accent)", animation: "pulse 1.5s infinite",
            }} />
            LLM 工作中
          </div>
        )}

        {/* Assistant summaries — when LLM finishes, show the final plan summary */}
        {summaries.map((m, i) => (
          <div key={i} style={{
            marginBottom: 10, padding: "12px 16px",
            background: "var(--bg-panel)", borderRadius: 10,
            fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap",
            wordBreak: "break-word", color: "var(--text)",
          }}>
            {m.content || "…"}
          </div>
        ))}

        {hasSession && summaries.length === 0 && agentRunning && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic", padding: "12px 0" }}>
            AI 正在规划中...
          </div>
        )}
      </div>

      {/* Input area */}
      <div style={{
        padding: "12px 16px 14px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}>
        {!hasSession && modelList.length > 1 && model && (
          <select
            value={`${model.provider}/${model.modelId}`}
            onChange={(e) => {
              const [provider, modelId] = e.target.value.split("/");
              if (provider && modelId) {
                onModelChange?.(provider, modelId);
              }
            }}
            style={{
              marginBottom: 8, padding: "4px 8px", fontSize: 11,
              background: "var(--bg)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 6, width: "100%",
            }}
          >
            {modelList.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.name} ({m.provider})
              </option>
            ))}
          </select>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={hasSession ? "追问或确认…" : "输入活动需求…"}
            style={{
              flex: 1, resize: "none", minHeight: 44, maxHeight: 120,
              background: "var(--bg)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 8,
              padding: "10px 14px", fontSize: 13, fontFamily: "inherit",
              lineHeight: 1.5,
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleAction();
              }
            }}
          />
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {agentRunning && (
              <button
                onClick={handleAbort}
                disabled={aborting}
                title="停止当前 LLM 任务"
                style={{
                  padding: "0 14px", height: 44,
                  background: "none", border: "1px solid var(--border)",
                  color: aborting ? "var(--text-dim)" : "#ef4444",
                  borderRadius: 8, fontSize: 12, fontWeight: 600,
                  cursor: aborting ? "default" : "pointer",
                }}
              >{aborting ? "停止中" : "停止"}</button>
            )}
            <button
              onClick={handleAction}
              disabled={!actionEnabled}
              style={{
                padding: "0 22px", height: 44,
                background: actionEnabled ? "var(--accent)" : "var(--bg-hover)",
                color: actionEnabled ? "white" : "var(--text-dim)",
                border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600,
                cursor: actionEnabled ? "pointer" : "default",
                whiteSpace: "nowrap",
              }}
            >{hasSession ? "发送" : "开始规划"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
