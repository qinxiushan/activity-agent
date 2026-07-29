import type {
  DataProvider,
  DistanceMatrixEntry,
  DistanceMatrixMode,
  RoutePoint,
} from "./data-provider";
import type { RouteResult, TransitMode } from "./route-service";

export type RoutePriority = "balanced" | "fastest" | "cheapest" | "low_walking";

export interface RouteOption extends RouteResult {
  available: true;
  score: number;
}

export interface UnavailableRouteOption {
  mode: TransitMode;
  available: false;
  reason: string;
}

export interface RouteComparison {
  from: RoutePoint;
  to: RoutePoint;
  options: Array<RouteOption | UnavailableRouteOption>;
  recommendedMode: TransitMode | null;
  recommendationReason: string;
}

const ALL_MODES: TransitMode[] = ["walking", "transit", "driving", "bicycling"];

function scoreRoute(
  route: RouteResult,
  priority: RoutePriority,
  weatherCondition: string,
  maxWalkingMinutes?: number,
): number {
  const duration = Math.min(1, route.durationMinutes / 120);
  const cost = Math.min(1, route.estimatedCost / 50);
  let score = priority === "fastest"
    ? duration
    : priority === "cheapest"
      ? cost * 0.8 + duration * 0.2
      : priority === "low_walking"
        ? duration * 0.45 + cost * 0.15 + (route.mode === "walking" ? 0.4 : 0)
        : duration * 0.6 + cost * 0.25;
  if (/雨|雪|高温|台风|霾|沙尘/.test(weatherCondition) &&
      (route.mode === "walking" || route.mode === "bicycling")) score += 0.45;
  if (maxWalkingMinutes !== undefined && route.mode === "walking" &&
      route.durationMinutes > maxWalkingMinutes) score += 1;
  return Number(score.toFixed(4));
}

export class RoutePlanningService {
  constructor(private readonly provider: DataProvider) {}

  async compare(
    from: RoutePoint,
    to: RoutePoint,
    options: {
      modes?: TransitMode[];
      priority?: RoutePriority;
      weatherCondition?: string;
      maxWalkingMinutes?: number;
    } = {},
  ): Promise<RouteComparison> {
    const modes = [...new Set(options.modes?.length ? options.modes : ALL_MODES)];
    const priority = options.priority ?? "balanced";
    const settled = await Promise.allSettled(modes.map((mode) => this.provider.computeRoute(from, to, mode)));
    const routeOptions = settled.map((result, index): RouteOption | UnavailableRouteOption => {
      const mode = modes[index]!;
      if (result.status === "rejected") {
        return { mode, available: false, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) };
      }
      return {
        ...result.value,
        available: true,
        score: scoreRoute(result.value, priority, options.weatherCondition ?? "", options.maxWalkingMinutes),
      };
    });
    const available = routeOptions
      .filter((item): item is RouteOption => item.available)
      .sort((a, b) => a.score - b.score || a.durationMinutes - b.durationMinutes);
    const best = available[0];
    return {
      from,
      to,
      options: routeOptions,
      recommendedMode: best?.mode ?? null,
      recommendationReason: best
        ? `${priority} 策略选择${best.description}；费用可信度 ${best.costConfidence ?? "unknown"}`
        : "所有请求的交通方式均不可用",
    };
  }

  async matrix(
    points: RoutePoint[],
    mode: DistanceMatrixMode,
    startId: string,
    fixedEndId?: string,
  ): Promise<{
    mode: DistanceMatrixMode;
    points: RoutePoint[];
    entries: DistanceMatrixEntry[];
    suggestedOrder: string[];
    totalDistanceMeters: number;
    totalDurationMinutes: number | null;
  }> {
    const entries = await this.provider.computeDistanceMatrix(points, mode);
    const lookup = new Map(entries.map((entry) => [`${entry.fromId}:${entry.toId}`, entry]));
    const unvisited = new Set(points.map((point) => point.id).filter((id) => id !== startId && id !== fixedEndId));
    const order = [startId];
    let current = startId;
    while (unvisited.size > 0) {
      const next = [...unvisited]
        .map((id) => ({ id, entry: lookup.get(`${current}:${id}`) }))
        .filter((item): item is { id: string; entry: DistanceMatrixEntry } => !!item.entry)
        .sort((a, b) => a.entry.distanceMeters - b.entry.distanceMeters)[0];
      if (!next) break;
      order.push(next.id);
      unvisited.delete(next.id);
      current = next.id;
    }
    if (fixedEndId && fixedEndId !== startId) order.push(fixedEndId);
    let totalDistanceMeters = 0;
    let totalDurationMinutes = mode === "straight" ? null : 0;
    for (let index = 0; index < order.length - 1; index++) {
      const entry = lookup.get(`${order[index]}:${order[index + 1]}`);
      if (!entry) continue;
      totalDistanceMeters += entry.distanceMeters;
      if (totalDurationMinutes !== null) totalDurationMinutes += entry.durationMinutes ?? 0;
    }
    return { mode, points, entries, suggestedOrder: order, totalDistanceMeters, totalDurationMinutes };
  }
}
