"use client";

import type { ActivityToolCall, ActivityPlanState } from "@/hooks/useActivitySession";

interface ItineraryDetails {
  downloadUrl: string;
  navigationLinks: Array<{ poiId: string; poiName: string; url: string }>;
  diningSearchLinks: Array<{ poiId: string; poiName: string; url: string }>;
}

function extractItinerary(toolCalls: ActivityToolCall[]): ItineraryDetails | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i]!;
    if (call.name !== "commit_itinerary" || !call.ok) continue;
    let parsed: Record<string, unknown> | null = null;
    if (typeof call.result === "string") {
      try { parsed = JSON.parse(call.result) as Record<string, unknown>; } catch { continue; }
    } else if (call.result && typeof call.result === "object") parsed = call.result as Record<string, unknown>;
    const data = (parsed?.details as Record<string, unknown> | undefined) ?? parsed;
    if (!data || typeof data.downloadUrl !== "string") continue;
    return {
      downloadUrl: data.downloadUrl,
      navigationLinks: Array.isArray(data.navigationLinks) ? data.navigationLinks as ItineraryDetails["navigationLinks"] : [],
      diningSearchLinks: Array.isArray(data.diningSearchLinks) ? data.diningSearchLinks as ItineraryDetails["diningSearchLinks"] : [],
    };
  }
  return null;
}

export function BookingCard({ toolCalls, planState }: { toolCalls: ActivityToolCall[]; planState: ActivityPlanState | null }) {
  const itinerary = extractItinerary(toolCalls);
  const isExecuting = planState?.phase === "executing";
  if (!itinerary && !isExecuting) return null;

  if (!itinerary) {
    return <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 12, padding: "16px 18px", marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8, fontWeight: 600 }}>正在生成行程…</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>正在冻结方案、生成 .ics 日历文件与导航交接链接。</div>
    </div>;
  }

  return <div style={{ background: "linear-gradient(135deg, color-mix(in srgb, #16a34a 8%, var(--bg-panel)), var(--bg-panel))", border: "1px solid color-mix(in srgb, #16a34a 35%, var(--border))", borderRadius: 12, padding: "16px 18px", marginBottom: 12 }}>
    <div style={{ fontSize: 11, color: "#16a34a", textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 700, marginBottom: 8 }}>行程已生成</div>
    <a href={itinerary.downloadUrl} style={{ display: "block", textAlign: "center", background: "#16a34a", color: "white", textDecoration: "none", padding: "8px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>下载 .ics 日历文件</a>
    {itinerary.navigationLinks.length > 0 && <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-muted)" }}>
      <div style={{ color: "var(--text-dim)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 5 }}>高德导航</div>
      {itinerary.navigationLinks.map((link) => <a key={link.poiId} href={link.url} target="_blank" rel="noreferrer" style={{ display: "block", color: "var(--accent)", marginBottom: 3 }}>{link.poiName}</a>)}
    </div>}
    {itinerary.diningSearchLinks.length > 0 && <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)", fontSize: 10, color: "var(--text-dim)" }}>
      餐厅链接会打开平台搜索页，供你自行继续订位；本系统未代为订位。
    </div>}
  </div>;
}
