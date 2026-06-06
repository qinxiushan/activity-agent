/**
 * Route Service - 通勤时间计算（mock）
 *
 * SOP 中"路径规划"环节的核心。
 * Demo 阶段：基于 haversine 距离 + 速度假设估算。
 * 生产阶段：替换 computeRoute() 实现为高德/百度路径规划 API。
 */

export type TransitMode = "walking" | "transit" | "driving";

export interface CoordWithId {
  id: string;
  name?: string;
  lng: number;
  lat: number;
}

const SPEED_KMH: Record<TransitMode, number> = {
  walking: 5,
  transit: 20,
  driving: 30,
};

const OVERHEAD_MIN: Record<TransitMode, number> = {
  walking: 2,
  transit: 8,
  driving: 5,
};

export interface RouteResult {
  fromId: string;
  toId: string;
  mode: TransitMode;
  distanceMeters: number;
  durationMinutes: number;
  estimatedCost: number;
  description: string;
}

export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function inferMode(distanceM: number): TransitMode {
  if (distanceM < 1500) return "walking";
  if (distanceM < 8000) return "transit";
  return "driving";
}

function estimateCost(distanceM: number, mode: TransitMode): number {
  const km = distanceM / 1000;
  switch (mode) {
    case "walking": return 0;
    case "transit": return Math.max(3, Math.ceil(km * 0.5));
    case "driving": return Math.max(12, Math.ceil(km * 2.5));
  }
}

export function computeRoute(
  from: CoordWithId,
  to: CoordWithId,
  preferredMode?: TransitMode,
): RouteResult {
  const distanceM = haversineMeters(from, to);
  const mode = preferredMode ?? inferMode(distanceM);
  const speed = SPEED_KMH[mode];
  const driveMin = (distanceM / 1000) / speed * 60;
  const durationMinutes = Math.round(driveMin + OVERHEAD_MIN[mode]);
  const cost = estimateCost(distanceM, mode);
  return {
    fromId: from.id,
    toId: to.id,
    mode,
    distanceMeters: Math.round(distanceM),
    durationMinutes,
    estimatedCost: cost,
    description: `${mode === "walking" ? "步行" : mode === "transit" ? "公共交通" : "驾车"} ${(distanceM / 1000).toFixed(1)}km，约 ${durationMinutes} 分钟`,
  };
}

export interface RouteLeg {
  fromName: string;
  toName: string;
  mode: TransitMode;
  distanceKm: number;
  durationMin: number;
  description: string;
}

export function buildRouteChain(
  stops: Array<{ id: string; name: string; lat: number; lng: number }>,
  mode?: TransitMode,
): { totalKm: number; totalMin: number; totalCost: number; legs: RouteLeg[] } {
  const legs: RouteLeg[] = [];
  let totalKm = 0, totalMin = 0, totalCost = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    const r = computeRoute(a, b, mode);
    totalKm += r.distanceMeters / 1000;
    totalMin += r.durationMinutes;
    totalCost += r.estimatedCost;
    legs.push({
      fromName: a.name,
      toName: b.name,
      mode: r.mode,
      distanceKm: Math.round((r.distanceMeters / 1000) * 10) / 10,
      durationMin: r.durationMinutes,
      description: r.description,
    });
  }
  return {
    totalKm: Math.round(totalKm * 10) / 10,
    totalMin,
    totalCost,
    legs,
  };
}
