"use client";

import { useEffect, useState } from "react";
import { ActivityPanel } from "@/components/activity/ActivityPanel";
import { UserPreferencesPanel } from "@/components/UserPreferencesPanel";
import { useActivitySession } from "@/hooks/useActivitySession";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface ModelsResponse {
  modelList: ModelInfo[];
  defaultModel: { provider: string; modelId: string } | null;
}

export function ActivityPanelWrapper() {
  const [input, setInput] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const [model, setModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelList, setModelList] = useState<ModelInfo[]>([]);
  const [aborting, setAborting] = useState(false);
  const activity = useActivitySession();

  useEffect(() => {
    fetch("/api/home")
      .then((r) => r.json())
      .then((d: { home?: string }) => { if (d.home) setCwd(d.home); })
      .catch(() => {});
    fetch("/api/models")
      .then((r) => r.json())
      .then((d: ModelsResponse) => {
        setModelList(d.modelList ?? []);
        if (d.defaultModel) setModel({ provider: d.defaultModel.provider, modelId: d.defaultModel.modelId });
        else if ((d.modelList ?? [])[0]) setModel({ provider: d.modelList[0]!.provider, modelId: d.modelList[0]!.id });
      })
      .catch(() => {});
  }, []);

  const canStart = !!cwd && !!model && input.trim().length > 0 && !activity.agentRunning;
  const canSend = !!activity.sessionId && input.trim().length > 0 && !activity.agentRunning;
  const actionEnabled = activity.sessionId ? canSend : canStart;
  const actionLabel = activity.sessionId ? "发送" : "开始";

  const handleAction = () => {
    if (activity.sessionId) {
      if (!canSend) return;
      void activity.sendMessage(input);
    } else {
      if (!canStart || !cwd || !model) return;
      void activity.startSession(cwd, input, model);
    }
    setInput("");
  };

  const handleAbort = async () => {
    if (aborting) return;
    setAborting(true);
    try {
      await activity.abort();
    } finally {
      setAborting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{
        padding: "10px 14px", borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <div style={{
          fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 600,
        }}>
          Activity Panel
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          {activity.sessionId && (
            <button
              onClick={() => activity.reset()}
              title="丢弃当前会话,下次发送将创建新 session"
              style={{
                background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
                padding: "2px 8px", borderRadius: 6, fontSize: 10, cursor: "pointer",
              }}
            >新会话</button>
          )}
          {activity.agentRunning && (
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
          {activity.sseReconnecting && (
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

      <div style={{ flex: 1, overflowY: "auto", padding: "12px" }}>
        {activity.error && (
          <div style={{
            padding: "8px 10px", marginBottom: 10,
            color: "#ef4444", background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 6, fontSize: 11,
          }}>
            错误: {activity.error}
          </div>
        )}
        {activity.planStateError && (
          <div style={{
            padding: "6px 10px", marginBottom: 10,
            color: "#ef4444", background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: 6, fontSize: 10,
            display: "flex", alignItems: "center", gap: 8,
          }}>
            <span style={{ flex: 1 }}>{activity.planStateError}</span>
            <button
              onClick={() => void activity.retryPlanPoll()}
              title="立即重试 plan-state 请求"
              style={{
                background: "none", border: "1px solid rgba(239,68,68,0.4)",
                color: "#ef4444", padding: "1px 8px", borderRadius: 4, fontSize: 10,
                cursor: "pointer", flexShrink: 0,
              }}
            >重试</button>
          </div>
        )}
        {activity.messages.length === 0 && !activity.sessionId && (
          <div style={{ textAlign: "center", color: "var(--text-dim)", padding: "32px 12px" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>开始一个活动规划</div>
            <div style={{ fontSize: 10 }}>输入需求,实时查看 SOP 阶段 + 工具调用 + 方案时间线</div>
          </div>
        )}
        {activity.messages.map((m, i) => (
          <div key={i} style={{
            marginBottom: 8,
            display: "flex", flexDirection: m.role === "user" ? "row-reverse" : "row",
          }}>
            <div style={{
              maxWidth: "88%", padding: "6px 10px", borderRadius: 10,
              background: m.role === "user" ? "var(--accent)" : "var(--bg-panel)",
              color: m.role === "user" ? "white" : "var(--text)",
              fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>
              {m.content || (m.role === "assistant" ? "…" : "")}
            </div>
          </div>
        ))}
        <UserPreferencesPanel />
        <ActivityPanel planState={activity.planState} toolCalls={activity.toolCalls} />
      </div>

      <div style={{
        padding: "8px 12px 10px", borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}>
        {!activity.sessionId && modelList.length > 1 && model && (
          <select
            value={`${model.provider}/${model.modelId}`}
            onChange={(e) => {
              const [provider, modelId] = e.target.value.split("/");
              if (provider && modelId) setModel({ provider, modelId });
            }}
            style={{
              marginBottom: 6, padding: "3px 6px", fontSize: 10,
              background: "var(--bg)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 5, width: "100%",
            }}
          >
            {modelList.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.name} ({m.provider})
              </option>
            ))}
          </select>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={activity.sessionId ? "追问或确认…" : "输入活动需求…"}
            style={{
              flex: 1, resize: "none", minHeight: 36, maxHeight: 80,
              background: "var(--bg)", color: "var(--text)",
              border: "1px solid var(--border)", borderRadius: 6,
              padding: "6px 10px", fontSize: 12, fontFamily: "inherit",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleAction();
              }
            }}
          />
          <button
            onClick={handleAction}
            disabled={!actionEnabled}
            style={{
              padding: "0 14px",
              background: actionEnabled ? "var(--accent)" : "var(--bg-hover)",
              color: actionEnabled ? "white" : "var(--text-dim)",
              border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600,
              cursor: actionEnabled ? "pointer" : "default",
            }}
          >{actionLabel}</button>
        </div>
      </div>
    </div>
  );
}
