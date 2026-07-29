"use client";

import type { ActivityPlanState } from "@/hooks/useActivitySession";
import { hasAdaptivePriceRange } from "@/lib/cost-resolver";

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

      {plan.budgetBreakdown && (
        <div style={{
          padding: "10px 12px", marginBottom: 12, borderRadius: 8,
          background: "var(--bg-hover)", border: "1px solid var(--border)",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            fontSize: 11, marginBottom: 8,
          }}>
            <span style={{ color: "var(--text)", fontWeight: 600 }}>预算账本</span>
            <span style={{
              color: plan.budgetBreakdown.status === "exceeded"
                ? "#ef4444"
                : plan.budgetBreakdown.status === "near_limit" ? "#f59e0b" : "#10b981",
              fontWeight: 600,
            }}>
              {plan.budgetBreakdown.status === "exceeded"
                ? `超预算 ¥${Math.abs(plan.budgetBreakdown.remaining)}`
                : `剩余 ¥${plan.budgetBreakdown.remaining}`}
            </span>
          </div>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 6, fontSize: 10, color: "var(--text-muted)",
          }}>
            <span>已知 ¥{plan.budgetBreakdown.knownTotal}</span>
            <span>估算 ¥{plan.budgetBreakdown.estimatedTotal}</span>
            <span>预留 ¥{plan.budgetBreakdown.reserveTotal}</span>
            <span>预计 ¥{plan.budgetBreakdown.projectedTotal}</span>
          </div>
          {typeof plan.budgetBreakdown.minimumTotal === "number" &&
            typeof plan.budgetBreakdown.maximumTotal === "number" && (
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>
                参考区间 ¥{plan.budgetBreakdown.minimumTotal} - ¥{plan.budgetBreakdown.maximumTotal}
                {" · "}
                {plan.budgetBreakdown.reserveStrategy === "conservative"
                  ? "保守策略"
                  : plan.budgetBreakdown.reserveStrategy === "minimal" ? "最低策略" : "均衡策略"}
              </div>
            )}
          {plan.budgetBreakdown.items.map((item) => (
            <div key={item.id} style={{
              display: "flex", justifyContent: "space-between", gap: 8,
              marginTop: 6, fontSize: 10, color: "var(--text-dim)",
            }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.label}
                {item.confidence === "estimate" ? "（估算）" : item.confidence === "unknown" ? "（预留）" : ""}
              </span>
              <span style={{ flexShrink: 0 }}>¥{item.amount}</span>
              {!item.originalPriceKnown && hasAdaptivePriceRange(item.priceRange) && (
                <span style={{ flexShrink: 0 }}>
                  区间 ¥{item.priceRange.low}-{item.priceRange.high}/人
                </span>
              )}
            </div>
          ))}
          {plan.budgetBreakdown.unknownPriceCount > 0 && (
            <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 8 }}>
              {plan.budgetBreakdown.unknownPriceCount} 项价格未知，预留金额不代表真实价格
            </div>
          )}
        </div>
      )}

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
        <span>总计 ¥{plan.totalCost}</span>
        {plan.budgetBreakdown && typeof plan.budgetBreakdown.projectedPerPerson === "number" && (
          <span>人均 ¥{plan.budgetBreakdown.projectedPerPerson}</span>
        )}
        <span>{plan.timeline.length} 段</span>
      </div>
    </div>
  );
}
