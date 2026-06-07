"use client";

import type { ActivityPlanState } from "@/hooks/useActivitySession";

const TYPE_ICONS: Record<string, string> = {
  departure: "D",
  transit: "T",
  activity: "A",
  meal: "M",
  rest: "R",
};

const TYPE_COLORS: Record<string, string> = {
  departure: "#6b7280",
  transit: "#0ea5e9",
  activity: "#10b981",
  meal: "#f59e0b",
  rest: "#8b5cf6",
};

export function PlanTimeline({ planState }: { planState: ActivityPlanState | null }) {
  if (!planState?.plan) {
    return (
      <div style={{
        background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "16px 18px", marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
          letterSpacing: 0.6, marginBottom: 12, fontWeight: 600,
        }}>
          方案时间线
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", padding: "16px 0" }}>
          {planState?.phase === "planning" ? "LLM 正在自动规划…" : "等待方案生成"}
        </div>
      </div>
    );
  }

  const plan = planState.plan;
  const weather = plan.weather;

  return (
    <div style={{
      background: "var(--bg-panel)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "16px 18px", marginBottom: 12,
    }}>
      <div style={{
        fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
        letterSpacing: 0.6, marginBottom: 10, fontWeight: 600,
      }}>
        方案时间线
      </div>

      {weather && (
        <div style={{
          fontSize: 11, color: "var(--text-muted)", marginBottom: 10,
          padding: "6px 10px", background: "var(--bg-hover)", borderRadius: 6,
        }}>
          {weather.city} {weather.date} · {weather.condition} · {weather.tempMin}°C ~ {weather.tempMax}°C
        </div>
      )}

      <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 12, lineHeight: 1.5 }}>
        {plan.summary}
      </div>

      <div style={{ position: "relative" }}>
        <div style={{
          position: "absolute", left: 11, top: 8, bottom: 8,
          width: 2, background: "var(--border)",
        }} />
        {plan.timeline.map((leg, i) => {
          const icon = TYPE_ICONS[leg.type] ?? "•";
          const color = TYPE_COLORS[leg.type] ?? "var(--text-dim)";
          return (
            <div key={i} style={{
              display: "flex", gap: 10, position: "relative", paddingBottom: 12,
            }}>
              <div style={{
                width: 24, height: 24, borderRadius: "50%", background: color,
                color: "white", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, flexShrink: 0, zIndex: 1,
              }}>
                {icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
                  {leg.startTime} → {leg.endTime}
                </div>
                <div style={{ fontSize: 12, color: "var(--text)", fontWeight: 500, marginTop: 1 }}>
                  {leg.poiName ?? leg.type}
                </div>
                {leg.notes && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    {leg.notes}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{
        display: "flex", gap: 12, marginTop: 8, paddingTop: 10,
        borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-muted)",
      }}>
        <span>总时长 {Math.floor(plan.totalDurationMinutes / 60)}h{plan.totalDurationMinutes % 60}m</span>
        <span>人均 ¥{plan.totalCost}</span>
        <span>{plan.timeline.length} 段</span>
      </div>
    </div>
  );
}
