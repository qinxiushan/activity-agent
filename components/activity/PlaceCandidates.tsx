"use client";

import type { ActivityToolCall } from "@/hooks/useActivitySession";

interface PlaceView {
  id: string;
  name: string;
  city?: string;
  district?: string;
  address?: string;
  category?: string;
  rating?: number | null;
  averageCostPerPerson?: number | null;
  openingHours?: string | null;
  source?: string;
  rank?: number;
  relevanceScore?: number;
  diversityScore?: number;
  matchedKeywords?: string[];
  links?: {
    amapPlace?: string;
    amapNavigation?: string;
    diningSearch?: string;
  };
}

interface DiscoveryMetrics {
  rawResultCount?: number;
  uniqueCandidateCount?: number;
  returnedCount?: number;
  duplicateRate?: number;
  categoryCount?: number;
  typeGroupCount?: number;
  maxTypeGroupShare?: number;
  averagePairwiseSimilarity?: number;
}

const PLACE_TOOLS = new Set(["discover_place_candidates", "search_places_text", "search_places_nearby", "get_place_details"]);
const ALLOWED_LINK_HOSTS = new Set(["uri.amap.com", "www.dianping.com"]);

function detailsOf(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const value = result as { details?: unknown };
  return value.details ?? result;
}

function placesOf(call: ActivityToolCall): PlaceView[] {
  if (!PLACE_TOOLS.has(call.name) || !call.ok) return [];
  const details = detailsOf(call.result);
  if (!details || typeof details !== "object") return [];
  const record = details as { candidates?: unknown; pois?: unknown; places?: unknown };
  const values = Array.isArray(record.candidates)
    ? record.candidates
    : Array.isArray(record.places)
      ? record.places
      : Array.isArray(record.pois) ? record.pois : [];
  return values.filter((value): value is PlaceView =>
    !!value && typeof value === "object" &&
    typeof (value as PlaceView).id === "string" &&
    typeof (value as PlaceView).name === "string");
}

function safeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_LINK_HOSTS.has(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function PlaceCandidates({ toolCalls }: { toolCalls: ActivityToolCall[] }) {
  const places = new Map<string, PlaceView>();
  let latestRankedIds: string[] = [];
  let discoveryMetrics: DiscoveryMetrics | null = null;
  for (const call of toolCalls) {
    const callPlaces = placesOf(call);
    for (const place of callPlaces) places.set(place.id, { ...places.get(place.id), ...place });
    if (call.name === "discover_place_candidates" && call.ok && callPlaces.length > 0) {
      latestRankedIds = callPlaces.map((place) => place.id);
      const details = detailsOf(call.result);
      if (details && typeof details === "object") {
        discoveryMetrics = (details as { metrics?: DiscoveryMetrics }).metrics ?? null;
      }
    }
  }
  const ranked = latestRankedIds.flatMap((id) => {
    const place = places.get(id);
    return place ? [place] : [];
  });
  const rankedIds = new Set(latestRankedIds);
  const unranked = [...places.values()].filter((place) => !rankedIds.has(place.id));
  const values = [...ranked, ...unranked].slice(0, 20);
  if (values.length === 0) return null;

  return (
    <section style={{
      background: "var(--bg-panel)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "16px 18px", marginBottom: 12,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 10,
      }}>
        <div style={{
          fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase",
          letterSpacing: 0.6, fontWeight: 600,
        }}>
          POI 候选
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{values.length} places</div>
      </div>
      {discoveryMetrics && (
        <div style={{
          display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10,
          fontSize: 10, color: "var(--text-dim)",
        }}>
          <span>原始: {discoveryMetrics.rawResultCount ?? "-"}</span>
          <span>去重后: {discoveryMetrics.uniqueCandidateCount ?? "-"}</span>
          <span>重复率: {discoveryMetrics.duplicateRate === undefined ? "-" : `${Math.round(discoveryMetrics.duplicateRate * 100)}%`}</span>
          <span>类别: {discoveryMetrics.categoryCount ?? "-"}</span>
          <span>类型组: {discoveryMetrics.typeGroupCount ?? "-"}</span>
          <span>最高类型占比: {discoveryMetrics.maxTypeGroupShare === undefined ? "-" : `${Math.round(discoveryMetrics.maxTypeGroupShare * 100)}%`}</span>
          <span>平均相似度: {discoveryMetrics.averagePairwiseSimilarity === undefined ? "-" : discoveryMetrics.averagePairwiseSimilarity.toFixed(2)}</span>
        </div>
      )}
      <div style={{ display: "grid", gap: 8, maxHeight: 420, overflowY: "auto" }}>
        {values.map((place) => {
          const placeUrl = safeUrl(place.links?.amapPlace);
          const navUrl = safeUrl(place.links?.amapNavigation);
          const diningUrl = safeUrl(place.links?.diningSearch);
          return (
            <article key={place.id} style={{
              border: "1px solid var(--border)", borderRadius: 10, padding: 10,
              background: "var(--bg)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 600 }}>{place.name}</div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                    {[place.city, place.district, place.category].filter(Boolean).join(" / ")}
                  </div>
                </div>
                <span style={{ fontSize: 9, color: "var(--text-dim)", flexShrink: 0 }}>
                  {place.rank ? `#${place.rank} · ` : ""}{place.source ?? "unknown"}
                </span>
              </div>
              {place.address && (
                <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>{place.address}</div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 7, fontSize: 10 }}>
                <span>评分: {place.rating ?? "未知"}</span>
                <span>人均: {place.averageCostPerPerson === null || place.averageCostPerPerson === undefined ? "未知" : `¥${place.averageCostPerPerson}`}</span>
                <span>营业: {place.openingHours || "未知"}</span>
                {place.diversityScore !== undefined && <span>多样性分: {place.diversityScore.toFixed(2)}</span>}
              </div>
              {place.matchedKeywords && place.matchedKeywords.length > 0 && (
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 5 }}>
                  命中: {place.matchedKeywords.join(" / ")}
                </div>
              )}
              {(placeUrl || navUrl || diningUrl) && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                  {placeUrl && <a href={placeUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>查看地点</a>}
                  {navUrl && <a href={navUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>高德导航</a>}
                  {diningUrl && <a href={diningUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>餐厅搜索</a>}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
