"use client";

import type { ActivityPlanState } from "@/hooks/useActivitySession";

const PHASES = [
  { key: "idle", label: "待命", icon: "○" },
  { key: "intent_capture", label: "意图捕获", icon: "" },
  { key: "clarifying", label: "追问", icon: "?" },
  { key: "planning", label: "自动规划", icon: "" },
  { key: "plan_confirm", label: "等待确认", icon: "" },
  { key: "executing", label: "执行预订", icon: "→" },
  { key: "completed", label: "完成", icon: "✓" },
  { key: "cancelled", label: "已取消", icon: "✕" },
] as const;

const PHASE_DESCRIPTIONS: Record<string, string> = {
  idle: "准备中…",
  intent_capture: "分析用户输入，提取关键字段",
  clarifying: "等待用户回答追问（最多 1 次）",
  planning: "自动调取天气 / POI / 路线数据",
  plan_confirm: "等待用户对最终方案确认",
  executing: "执行真实预订",
  completed: "已完成",
  cancelled: "已取消",
};

export function PhaseProgress({ planState }: { planState: ActivityPlanState | null }) {
  const currentKey = planState?.phase ?? "idle";
  const isCancelled = currentKey === "cancelled";
  const effectiveKey = isCancelled
    ? planState?.history?.filter((h) => h.phase !== "cancelled").at(-1)?.phase ?? "idle"
    : currentKey;
  const currentIdx = PHASES.findIndex((p) => p.key === effectiveKey);

  return (
    <div style={{
      background: "var(--bg-panel)",
      border: "1px solid var(--border)",
      borderRadius: 12,
      padding: "16px 18px",
      marginBottom: 12,
    }}>
      <div style={{
        fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
        letterSpacing: 0.6, marginBottom: 12, fontWeight: 600,
      }}>
        SOP-v2 阶段进度
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {PHASES.slice(0, 7).map((p, i) => {
            const isCurrent = p.key === effectiveKey;
            const isPast = i < currentIdx;
            const dotBg = isCurrent
              ? "var(--accent)"
              : isPast
                ? "color-mix(in srgb, var(--accent) 50%, transparent)"
                : "var(--bg-hover)";
            const dotColor = isCurrent || isPast ? "white" : "var(--text-dim)";
            const isLast = i === 6;
            const connectorBg = isPast
              ? "color-mix(in srgb, var(--accent) 50%, transparent)"
              : "var(--border)";
            return (
              <div key={p.key} style={{ display: "flex", alignItems: "center", flex: isLast ? "0 0 auto" : 1, minWidth: 0 }}>
                <div style={{
                  width: 26, height: 26, borderRadius: "50%",
                  background: dotBg, color: dotColor,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 600, flexShrink: 0,
                  boxShadow: isCurrent ? "0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent)" : "none",
                  transition: "all 0.3s",
                }}>
                  {isPast ? "✓" : p.icon}
                </div>
                {!isLast && (
                  <div style={{
                    flex: 1, height: 2, background: connectorBg,
                    marginLeft: 4, marginRight: 4, minWidth: 4,
                    transition: "background 0.3s",
                  }} />
                )}
              </div>
            );
          })}
          {isCancelled && (
            <>
              <div style={{
                flex: 1, height: 2, background: "rgba(239,68,68,0.3)",
                marginLeft: 4, marginRight: 4, minWidth: 4,
              }} />
              <div style={{
                width: 26, height: 26, borderRadius: "50%",
                background: "rgba(239,68,68,0.15)", color: "#ef4444",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 600, flexShrink: 0,
                boxShadow: "0 0 0 4px rgba(239,68,68,0.15)",
              }}>✕</div>
            </>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 4, marginTop: 6 }}>
          {PHASES.slice(0, 7).map((p, i) => {
            const isCurrent = p.key === effectiveKey;
            const isLast = i === 6;
            return (
              <div key={p.key} style={{
                flex: isLast ? "0 0 auto" : 1, minWidth: 0,
                display: "flex", flexDirection: "column", alignItems: "center",
              }}>
                <div style={{
                  fontSize: 9, color: isCurrent ? "var(--text)" : "var(--text-dim)",
                  fontWeight: isCurrent ? 600 : 400, textAlign: "center",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  maxWidth: "100%",
                  paddingLeft: 4, paddingRight: 4,
                }}>
                  {p.label}
                </div>
              </div>
            );
          })}
          {isCancelled && (
            <div style={{
              flex: "0 0 auto", minWidth: 0,
              display: "flex", flexDirection: "column", alignItems: "center",
            }}>
              <div style={{
                fontSize: 9, color: "#ef4444", fontWeight: 600,
                textAlign: "center", whiteSpace: "nowrap",
                paddingLeft: 4, paddingRight: 4,
              }}>
                已取消
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px", borderRadius: 8,
        background: isCancelled ? "rgba(239,68,68,0.08)" : "color-mix(in srgb, var(--accent) 8%, transparent)",
        border: `1px solid ${isCancelled ? "rgba(239,68,68,0.3)" : "color-mix(in srgb, var(--accent) 30%, transparent)"}`,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: isCancelled ? "#ef4444" : "var(--accent)" }}>
          {isCancelled ? "✕" : "●"}
        </span>
        <span style={{ fontSize: 12, color: "var(--text)" }}>
          {PHASE_DESCRIPTIONS[currentKey] ?? currentKey}
        </span>
        {planState && (
          <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
            turn {planState.turnCount}
            {planState.clarificationCount > 0 && ` · 追问 ${planState.clarificationCount}/1`}
          </span>
        )}
      </div>
    </div>
  );
}
