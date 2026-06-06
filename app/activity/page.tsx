"use client";

import { useEffect, useState } from "react";
import { ActivityPanel } from "@/components/activity/ActivityPanel";
import { useActivitySession } from "@/hooks/useActivitySession";
import { useTheme } from "@/hooks/useTheme";

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

interface ModelsResponse {
  modelList: ModelInfo[];
  defaultModel: { provider: string; modelId: string } | null;
}

const SAMPLE_PROMPTS = [
  "想和女朋友周六(2026-07-11)去玩，下午6点前要结束(10:00开始)，人在三里屯(北京朝阳)，预算300元/人",
  "周日(2026-07-12)一个人去上海陆家嘴，预算500，想逛逛博物馆",
  "和家人(4人)周六(2026-07-11)在北京玩，老妈腿脚不便，预算200/人",
];

export default function ActivityPage() {
  const [input, setInput] = useState(SAMPLE_PROMPTS[0]!);
  const [cwd, setCwd] = useState<string | null>(null);
  const [model, setModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelList, setModelList] = useState<ModelInfo[]>([]);
  const activity = useActivitySession();
  const { isDark, toggleTheme } = useTheme();

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { cwd?: string }) => {
      if (d.cwd) setCwd(d.cwd);
    }).catch(() => {});
    fetch("/api/models").then((r) => r.json()).then((d: ModelsResponse) => {
      setModelList(d.modelList);
      if (d.defaultModel) setModel({ provider: d.defaultModel.provider, modelId: d.defaultModel.modelId });
      else if (d.modelList[0]) setModel({ provider: d.modelList[0].provider, modelId: d.modelList[0].id });
    }).catch(() => {});
  }, []);

  const canStart = !!cwd && !!model && input.trim().length > 0 && !activity.agentRunning;

  return (
    <div style={{
      display: "flex", height: "100dvh", background: "var(--bg)",
      color: "var(--text)", overflow: "hidden",
    }}>
      {/* Left: chat */}
      <div style={{
        flex: 1, display: "flex", flexDirection: "column",
        borderRight: "1px solid var(--border)", minWidth: 0,
      }}>
        <div style={{
          padding: "16px 20px", borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <a href="/" style={{ color: "var(--text-muted)", textDecoration: "none", fontSize: 18 }}>←</a>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>🎯 Activity Agent</div>
              <div style={{ fontSize: 10, color: "var(--text-dim)" }}>SOP-v2 活动规划 · 单次确认 + 1 次追问</div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
                }}
                title={isDark ? "Switch to light mode" : "Switch to dark mode"}
                aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
                aria-pressed={isDark}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 28, height: 28, padding: 0,
                  background: "none", border: "1px solid var(--border)",
                  color: "var(--text-muted)", borderRadius: 6, cursor: "pointer",
                  transition: "color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                {isDark ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                )}
              </button>
              {activity.sessionId && (
                <button
                  onClick={() => activity.reset()}
                  style={{
                    background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
                    padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer",
                  }}
                >新会话</button>
              )}
              {activity.agentRunning && (
                <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--accent)" }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: "50%", background: "var(--accent)",
                    animation: "pulse 1.5s infinite",
                  }} />
                  LLM 工作中
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          {activity.messages.length === 0 && !activity.sessionId && (
            <div style={{ textAlign: "center", color: "var(--text-dim)", padding: "60px 20px" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>🎯</div>
              <div style={{ fontSize: 14, color: "var(--text-muted)", marginBottom: 6 }}>开始一个活动规划</div>
              <div style={{ fontSize: 11 }}>输入需求并发送，右侧面板实时显示 SOP 阶段 + 工具调用 + 方案时间线</div>
            </div>
          )}
          {activity.messages.map((m, i) => (
            <div key={i} style={{
              marginBottom: 12,
              display: "flex", flexDirection: m.role === "user" ? "row-reverse" : "row",
            }}>
              <div style={{
                maxWidth: "78%", padding: "10px 14px", borderRadius: 12,
                background: m.role === "user" ? "var(--accent)" : "var(--bg-panel)",
                color: m.role === "user" ? "white" : "var(--text)",
                fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}>
                {m.content || (m.role === "assistant" ? "…" : "")}
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div style={{
          padding: "12px 20px 16px", borderTop: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}>
          {!activity.sessionId && (
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {SAMPLE_PROMPTS.map((p, i) => (
                <button
                  key={i}
                  onClick={() => setInput(p)}
                  style={{
                    background: "var(--bg-hover)", border: "1px solid var(--border)",
                    color: "var(--text-muted)", padding: "4px 10px", borderRadius: 12,
                    fontSize: 10, cursor: "pointer", maxWidth: 280,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                >
                  {p.slice(0, 30)}…
                </button>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入活动需求…"
              disabled={!!activity.sessionId}
              style={{
                flex: 1, resize: "none", minHeight: 60, maxHeight: 120,
                background: "var(--bg)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 8,
                padding: "8px 12px", fontSize: 13, fontFamily: "inherit",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && canStart) {
                  e.preventDefault();
                  if (cwd && model) void activity.startSession(cwd, input, model);
                }
              }}
            />
            {!activity.sessionId ? (
              <button
                onClick={() => cwd && model && void activity.startSession(cwd, input, model)}
                disabled={!canStart}
                style={{
                  padding: "0 18px", background: canStart ? "var(--accent)" : "var(--bg-hover)",
                  color: canStart ? "white" : "var(--text-dim)",
                  border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  cursor: canStart ? "pointer" : "default",
                }}
              >开始</button>
            ) : (
              <button
                onClick={() => void activity.sendMessage(input)}
                disabled={!input.trim() || activity.agentRunning}
                style={{
                  padding: "0 18px", background: (!input.trim() || activity.agentRunning) ? "var(--bg-hover)" : "var(--accent)",
                  color: (!input.trim() || activity.agentRunning) ? "var(--text-dim)" : "white",
                  border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  cursor: (!input.trim() || activity.agentRunning) ? "default" : "pointer",
                }}
              >发送</button>
            )}
          </div>
          {!activity.sessionId && model && modelList.length > 1 && (
            <select
              value={`${model.provider}/${model.modelId}`}
              onChange={(e) => {
                const [provider, modelId] = e.target.value.split("/");
                if (provider && modelId) setModel({ provider, modelId });
              }}
              style={{
                marginTop: 8, padding: "4px 8px", fontSize: 11,
                background: "var(--bg)", color: "var(--text)",
                border: "1px solid var(--border)", borderRadius: 6,
              }}
            >
              {modelList.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.provider}/{m.id}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Right: activity panel */}
      <div style={{
        width: 420, flexShrink: 0, display: "flex", flexDirection: "column",
        background: "var(--bg)", overflow: "hidden",
      }}>
        <div style={{
          padding: "16px 18px", borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
        }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
            Activity Panel
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px" }}>
          {activity.error ? (
            <div style={{ padding: 16, color: "#ef4444", fontSize: 12 }}>错误: {activity.error}</div>
          ) : !activity.sessionId ? (
            <div style={{ textAlign: "center", color: "var(--text-dim)", padding: "60px 20px", fontSize: 12 }}>
              左侧发送消息后，阶段进度 + 工具调用 + 方案时间线会实时显示在这里
            </div>
          ) : (
            <ActivityPanel planState={activity.planState} toolCalls={activity.toolCalls} />
          )}
        </div>
      </div>
    </div>
  );
}
