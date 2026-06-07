"use client";

import { useCallback, useEffect, useState } from "react";
import type { UserDeparturePoint, UserPreferences } from "@/lib/user-preferences";

const DEFAULT_LABELS: Record<keyof UserPreferences["defaults"], string> = {
  partySize: "人数",
  groupType: "群体",
  budgetPerPerson: "人均预算",
  preferredCategories: "偏好品类",
  dietaryRestrictions: "饮食限制",
  mood: "氛围",
  departurePoint: "出发地",
};

const DISPLAY_FIELDS: (keyof UserPreferences["defaults"])[] = [
  "partySize", "groupType", "budgetPerPerson",
  "departurePoint", "preferredCategories",
  "dietaryRestrictions", "mood",
];

function isUserDeparturePoint(v: unknown): v is UserDeparturePoint {
  return typeof v === "object" && v !== null
    && typeof (v as { name?: unknown }).name === "string"
    && typeof (v as { city?: unknown }).city === "string";
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length === 0 ? "—" : v.join("、");
  if (isUserDeparturePoint(v)) return v.name;
  return String(v);
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}

export function UserPreferencesPanel() {
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [busy, setBusy] = useState<"refresh" | "reset" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/user-preferences");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { preferences: UserPreferences };
      setPrefs(d.preferences);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(t);
  }, [load]);

  const refresh = async () => {
    setBusy("refresh");
    try {
      const r = await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "refresh" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { preferences: UserPreferences };
      setPrefs(d.preferences);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "刷新失败");
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    if (!window.confirm("确定要重置所有用户偏好吗？此操作不可撤销。")) return;
    setBusy("reset");
    try {
      const r = await fetch("/api/user-preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { preferences: UserPreferences };
      setPrefs(d.preferences);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "重置失败");
    } finally {
      setBusy(null);
    }
  };

  if (error && !prefs) {
    return (
      <div style={{
        background: "var(--bg-panel)", border: "1px solid #ef4444",
        borderRadius: 12, padding: "12px 16px", marginBottom: 12, fontSize: 12, color: "#ef4444",
      }}>
        偏好加载失败: {error}
      </div>
    );
  }

  if (!prefs) {
    return (
      <div style={{
        background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "12px 16px", marginBottom: 12,
        fontSize: 11, color: "var(--text-dim)",
      }}>
        加载用户偏好…
      </div>
    );
  }

  const hasDefaults = DISPLAY_FIELDS.some((f) => prefs.defaults[f] !== undefined);

  return (
    <div style={{
      background: "var(--bg-panel)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "12px 16px", marginBottom: 12,
    }}>
      {/* Header row */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8,
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 600,
        }}>
          用户偏好
          <span style={{
            fontSize: 9, fontWeight: 400, fontFamily: "var(--font-mono)",
            textTransform: "none", letterSpacing: 0, opacity: 0.7,
          }} title="当前 prefs 归属的 userId">
            {prefs.userId}
          </span>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => void refresh()}
            disabled={busy !== null}
            title="根据历史 plan-state 重新计算默认偏好"
            style={{
              background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
              padding: "2px 8px", borderRadius: 6, fontSize: 10, cursor: busy ? "wait" : "pointer",
              opacity: busy === "refresh" ? 0.5 : 1,
            }}
          >
            {busy === "refresh" ? "…" : "刷新"}
          </button>
          <button
            onClick={() => void reset()}
            disabled={busy !== null}
            title="重置所有偏好"
            style={{
              background: "none", border: "1px solid var(--border)", color: "var(--text-muted)",
              padding: "2px 8px", borderRadius: 6, fontSize: 10, cursor: busy ? "wait" : "pointer",
              opacity: busy === "reset" ? 0.5 : 1,
            }}
          >
            重置
          </button>
        </div>
      </div>

      {/* Stats line */}
      <div style={{
        fontSize: 10, color: "var(--text-dim)", marginBottom: 8, fontFamily: "var(--font-mono)",
      }}>
        方案 {prefs.stats.totalCompletedPlans} · 预订 {prefs.stats.totalBookings} · {timeAgo(prefs.updatedAt)} 更新
      </div>

      {/* Defaults */}
      {hasDefaults ? (
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px",
          fontSize: 11, marginBottom: 8,
        }}>
          {DISPLAY_FIELDS.map((field) => {
            const value = prefs.defaults[field];
            if (value === undefined) return null;
            return (
              <div key={field} style={{ display: "flex", flexDirection: "column" }}>
                <span style={{ color: "var(--text-dim)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 }}>
                  {DEFAULT_LABELS[field]}
                </span>
                <span style={{ color: "var(--text)" }}>{formatValue(value)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8, fontStyle: "italic" }}>
          暂无偏好 — 完成首个方案后会自动学习
        </div>
      )}

      {/* Recent intents (collapsible) */}
      {prefs.recentSessions.length > 0 && (
        <>
          <button
            onClick={() => setExpanded(!expanded)}
            style={{
              background: "none", border: "none", color: "var(--text-muted)",
              fontSize: 10, padding: 0, cursor: "pointer", marginTop: 4,
            }}
          >
            {expanded ? "▼" : "▶"} 最近 {prefs.recentSessions.length} 次需求
          </button>
          {expanded && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              {prefs.recentSessions.map((session, i) => (
                <div key={i} style={{
                  fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)",
                  padding: "4px 6px", background: "var(--bg)", borderRadius: 4,
                }}>
                  {session.intent.date ?? "—"} · {session.intent.departurePoint?.name ?? "—"} · {session.intent.partySize ?? "—"}人
                  {session.intent.budgetPerPerson !== undefined && ` · ¥${session.intent.budgetPerPerson}`}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {error && (
        <div style={{ marginTop: 8, fontSize: 10, color: "#ef4444" }}>{error}</div>
      )}
    </div>
  );
}
