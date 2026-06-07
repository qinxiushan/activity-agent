"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasSession = !!sessionId;
  const canSend = !agentRunning && value.trim().length > 0;

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const msg = value.trim();
    setValue("");
    if (hasSession) {
      void onSendMessage(msg);
    } else {
      if (!cwd || !model) return;
      void onStartSession(cwd, msg, model);
    }
  }, [canSend, value, hasSession, cwd, model, onStartSession, onSendMessage]);

  const handleAbort = useCallback(() => {
    void onAbort();
  }, [onAbort]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const modelName = model ? `${model.provider}/${model.modelId}` : "No model";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 16px" }}>
        {!hasSession && !error && (
          <div style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", height: "100%", color: "var(--text-dim)",
          }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
              活动规划
            </div>
            <div style={{ fontSize: 12, maxWidth: 320, textAlign: "center", lineHeight: 1.6 }}>
              输入需求，AI 自动查询天气、搜索活动、计算路线，生成完整方案后等你确认。
            </div>
          </div>
        )}

        {error && (
          <div style={{
            padding: "12px", marginTop: 12,
            color: "#ef4444", background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.25)", borderRadius: 8, fontSize: 13,
          }}>
            {error}
          </div>
        )}

        {messages.map((msg, i) =>
          msg.role === "user" ? (
            <div key={i} style={{ marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "85%" }}>
                <div style={{
                  flex: 1, minWidth: 0,
                  background: "var(--user-bg)",
                  border: "1px solid rgba(59,130,246,0.2)",
                  borderRadius: 12,
                  padding: "8px 12px",
                  fontSize: 14, lineHeight: 1.6,
                  color: "var(--text)",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                }}>
                  {msg.content}
                </div>
              </div>
              {msg.timestamp && (
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                  {formatTime(msg.timestamp)}
                </div>
              )}
            </div>
          ) : (
            <div key={i} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
                {model?.modelId ?? "model"}
                {msg.timestamp && (
                  <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-dim)" }}>
                    {formatTime(msg.timestamp)}
                  </span>
                )}
              </div>
              <div className="markdown-body" style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text)" }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {msg.content || "..."}
                </ReactMarkdown>
              </div>
            </div>
          )
        )}

        {agentRunning && messages.length === 0 && (
          <div style={{ padding: "32px 0", textAlign: "center", fontSize: 13, color: "var(--text-dim)" }}>
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              background: "var(--accent)", marginRight: 8,
              animation: "pulse 1.5s infinite",
            }} />
            AI 工作中...
          </div>
        )}
      </div>

      <div style={{
        padding: "8px 12px 12px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-panel)",
      }}>
        <div style={{
          display: "flex", gap: 8, alignItems: "center",
          background: "var(--bg)",
          border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
          borderRadius: 14,
          padding: "10px 10px 10px 14px",
          boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
        }}>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={hasSession ? "追问或确认…" : "输入活动需求…"}
            rows={1}
            style={{
              flex: 1, background: "none", border: "none", outline: "none",
              resize: "none", color: "var(--text)", fontSize: 14,
              lineHeight: 1.6, fontFamily: "inherit",
              minHeight: 24, maxHeight: 200, overflow: "auto",
            }}
          />

          {agentRunning ? (
            <button
              onClick={handleAbort}
              style={{
                flexShrink: 0, alignSelf: "flex-end",
                display: "flex", alignItems: "center", gap: 6,
                padding: "7px 14px",
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.3)",
                borderRadius: 9,
                color: "#ef4444",
                cursor: "pointer", fontSize: 13, fontWeight: 600,
                whiteSpace: "nowrap",
                transition: "background 0.12s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
              </svg>
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              style={{
                flexShrink: 0, alignSelf: "flex-end",
                display: "flex", alignItems: "center", gap: 6,
                padding: "7px 14px",
                background: canSend ? "var(--accent)" : "var(--bg-panel)",
                border: "none",
                borderRadius: 8,
                color: canSend ? "#fff" : "var(--text-dim)",
                cursor: canSend ? "pointer" : "not-allowed",
                fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                boxShadow: canSend ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
                transition: "background 0.15s, box-shadow 0.15s",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              {hasSession ? "Send" : "Start"}
            </button>
          )}
        </div>

        {modelList.length > 0 && !agentRunning && (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <div ref={dropdownRef} style={{ position: "relative" }}>
              <button
                onClick={() => setModelDropdownOpen((v) => !v)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 12px", height: 32, maxWidth: 240, overflow: "hidden",
                  background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                  border: "none", borderRadius: 9,
                  color: "var(--text-muted)", cursor: "pointer", fontSize: 12,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                  <rect x="9" y="9" width="6" height="6" />
                  <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                  <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                  <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                  <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                </svg>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                  {modelName}
                </span>
              </button>
              {modelDropdownOpen && (
                (() => {
                  const grouped = new Map<string, ModelInfo[]>();
                  for (const m of modelList) {
                    const arr = grouped.get(m.provider) ?? [];
                    arr.push(m);
                    if (!grouped.has(m.provider)) grouped.set(m.provider, arr);
                  }
                  return (
                    <div style={{
                      position: "fixed",
                      bottom: 0, left: 0,
                      zIndex: 500, background: "var(--bg)",
                      border: "1px solid var(--border)",
                      borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", minWidth: 180, maxHeight: 320, overflowY: "auto",
                    }}>
                      {[...grouped.entries()].map(([provider, opts], gi) => (
                        <div key={provider}>
                          {grouped.size > 1 && (
                            <div style={{
                              padding: "6px 12px 4px", fontSize: 10, fontWeight: 600,
                              color: "var(--text-dim)", textTransform: "uppercase",
                              letterSpacing: "0.07em",
                              borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                            }}>
                              {provider}
                            </div>
                          )}
                          {opts.map((opt) => {
                            const isActive = opt.provider === model?.provider && opt.id === model?.modelId;
                            return (
                              <button
                                key={`${opt.provider}:${opt.id}`}
                                onClick={() => { setModelDropdownOpen(false); if (!isActive) onModelChange?.(opt.provider, opt.id); }}
                                style={{
                                  display: "flex", alignItems: "center", gap: 8,
                                  width: "100%", padding: "7px 12px",
                                  background: isActive ? "var(--bg-selected)" : "none",
                                  border: "none",
                                  color: isActive ? "var(--text)" : "var(--text-muted)",
                                  cursor: "pointer", fontSize: 12, textAlign: "left",
                                  fontWeight: isActive ? 600 : 400, whiteSpace: "nowrap",
                                }}
                                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                              >
                                {isActive
                                  ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                  : <span style={{ width: 10, flexShrink: 0 }} />}
                                {opt.name}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  );
                })()
              )}
            </div>
            <div style={{ flex: 1 }} />
          </div>
        )}
      </div>
    </div>
  );
}
