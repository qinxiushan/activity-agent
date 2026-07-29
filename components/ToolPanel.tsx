"use client";

import { useEffect, useRef } from "react";

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = "none" | "default" | "full";
export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = [
  "classify_turn", "intent_parse", "submit_plan", "ask_clarification",
  "detect_user_region", "geocode", "reverse_geocode", "get_weather",
  "discover_place_candidates", "search_places_text", "search_places_nearby", "get_place_details",
  "search_activities", "search_restaurants", "check_opening_hours", "compute_route",
  "commit_itinerary", "plan_save", "plan_load",
];
export const PRESET_FULL: string[] = [...PRESET_DEFAULT];

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const active = tools.filter(t => t.active).map(t => t.name).sort().join(",");
  if (active === "") return "none";
  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "default"; // closest match
}

interface Props {
  tools: ToolEntry[];
  onPreset: (preset: ToolPreset, toolNames: string[]) => void;
  onClose: () => void;
}

const PRESETS: { id: ToolPreset; label: string; desc: string; tools: string[] }[] = [
  { id: "none",    label: "Off",  desc: "No tools",                                tools: PRESET_NONE },
  { id: "default", label: "Plan", desc: "位置 · POI · 天气 · 路线 · 行程", tools: PRESET_DEFAULT },
  { id: "full",    label: "All",  desc: "全部活动规划工具", tools: PRESET_FULL },
];

export function ToolPanel({ tools, onPreset, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const current = getPresetFromTools(tools);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const currentIndex = PRESETS.findIndex(p => p.id === current);

  return (
    <div
      ref={panelRef}
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        zIndex: 200,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 -4px 20px rgba(0,0,0,0.10)",
        width: 260,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* Segmented control */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        background: "var(--bg-panel)",
        borderRadius: 8,
        padding: 3,
        gap: 3,
      }}>
        {PRESETS.map((preset) => {
          const isActive = current === preset.id;
          return (
            <button
              key={preset.id}
              onClick={() => { onPreset(preset.id, preset.tools); onClose(); }}
              style={{
                padding: "5px 0",
                borderRadius: 6,
                border: "none",
                background: isActive ? "var(--bg)" : "transparent",
                boxShadow: isActive ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
                color: isActive ? "var(--accent)" : "var(--text-muted)",
                fontWeight: isActive ? 600 : 400,
                fontSize: 12,
                cursor: "pointer",
                transition: "all 0.12s",
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {/* Description of current selection */}
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
        {currentIndex >= 0 ? PRESETS[currentIndex].desc || "No tools enabled" : ""}
        {current === "none" && <span> — agent will not use any tools</span>}
      </div>

      {/* Track bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {PRESETS.map((_, i) => (
          <div
            key={i}
            style={{
              flex: 1, height: 3, borderRadius: 2,
              background: i <= currentIndex ? "var(--accent)" : "var(--border)",
              transition: "background 0.15s",
            }}
          />
        ))}
      </div>

      <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
        takes effect on next turn
      </div>
    </div>
  );
}
