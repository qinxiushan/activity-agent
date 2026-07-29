"use client";

import type { ActivityToolCall } from "@/hooks/useActivitySession";

const TOOL_ICONS: Record<string, string> = {
  classify_turn: "CT",
  intent_parse: "IP",
  submit_plan: "SP",
  ask_clarification: "?",
  detect_user_region: "IR",
  geocode: "GC",
  reverse_geocode: "RG",
  get_weather: "GW",
  discover_place_candidates: "DC",
  search_places_text: "ST",
  search_places_nearby: "SN",
  get_place_details: "PD",
  search_activities: "SA",
  search_restaurants: "SR",
  check_opening_hours: "CH",
  compute_route: "CR",
  compare_route_options: "RC",
  distance_matrix: "DM",
  validate_itinerary: "VI",
  calculate_budget: "CB",
  commit_itinerary: "CI",
  query_booking: "QB",
  retry_booking: "RB",
  plan_save: "PS",
  plan_load: "PL",
};

const TOOL_COLORS: Record<string, string> = {
  classify_turn: "#4f46e5",
  intent_parse: "#6366f1",
  submit_plan: "#16a34a",
  ask_clarification: "#f59e0b",
  detect_user_region: "#64748b",
  geocode: "#0891b2",
  reverse_geocode: "#0e7490",
  get_weather: "#0ea5e9",
  discover_place_candidates: "#047857",
  search_places_text: "#059669",
  search_places_nearby: "#0d9488",
  get_place_details: "#7c3aed",
  search_activities: "#10b981",
  search_restaurants: "#f97316",
  check_opening_hours: "#8b5cf6",
  compute_route: "#06b6d4",
  compare_route_options: "#0284c7",
  distance_matrix: "#0369a1",
  validate_itinerary: "#7c3aed",
  calculate_budget: "#b45309",
  commit_itinerary: "#16a34a",
  query_booking: "#64748b",
  retry_booking: "#ef4444",
  plan_save: "#10b981",
  plan_load: "#64748b",
};

export function ToolTimeline({ toolCalls }: { toolCalls: ActivityToolCall[] }) {
  if (toolCalls.length === 0) {
    return (
      <div style={{
        background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "16px 18px", marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
          letterSpacing: 0.6, marginBottom: 12, fontWeight: 600,
        }}>
          工具调用时间线
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", textAlign: "center", padding: "16px 0" }}>
          等待 LLM 开始…
        </div>
      </div>
    );
  }

  return (
    <div style={{
      background: "var(--bg-panel)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "16px 18px", marginBottom: 12,
    }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 10,
      }}>
        <div style={{
          fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 600,
        }}>
          工具调用时间线
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
          {toolCalls.length} calls
        </div>
      </div>

      <div style={{ maxHeight: 360, overflowY: "auto" }}>
        {toolCalls.map((tc, i) => {
          const icon = TOOL_ICONS[tc.name] ?? "•";
          const color = TOOL_COLORS[tc.name] ?? "var(--text-dim)";
          const dur = tc.endedAt ? `${tc.endedAt - tc.startedAt}ms` : "running…";
          return (
            <div key={tc.id} style={{
              display: "flex", alignItems: "flex-start", gap: 10,
              padding: "6px 0",
              borderBottom: i < toolCalls.length - 1 ? "1px solid var(--border)" : "none",
            }}>
              <div style={{
                width: 22, height: 22, borderRadius: 6, background: color,
                color: "white", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 10, flexShrink: 0, marginTop: 1,
              }}>
                {icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>{tc.name}</span>
                  <span style={{ fontSize: 9, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>{dur}</span>
                  {!tc.ok && <span style={{ fontSize: 9, color: "#ef4444", fontWeight: 600 }}>BLOCKED</span>}
                </div>
                {tc.argsSummary && (
                  <div style={{
                    fontSize: 10, color: "var(--text-dim)", marginTop: 2,
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {tc.argsSummary}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
