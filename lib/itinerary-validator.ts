import { createHash } from "node:crypto";
import type { DataProvider, RoutePoint } from "./data-provider";
import type { PlanWarning, ProposedPlan } from "./plan-state";
import type { TransitMode } from "./route-service";

export type EndPolicy = "last_poi" | "return_to_start" | "specified";

export interface ItineraryStop {
  poiId: string;
  type: "activity" | "meal" | "rest";
  durationMinutes: number;
  notes?: string;
}

export interface ItineraryLeg {
  fromId: string;
  toId: string;
  mode: TransitMode;
  distanceMeters: number;
  durationMinutes: number;
  estimatedCost: number;
}

export type ValidationIssue = PlanWarning;

export interface ItineraryValidationResult {
  valid: boolean;
  validationToken: string;
  endPolicy: EndPolicy;
  timeline: ProposedPlan["timeline"];
  violations: ValidationIssue[];
  warnings: ValidationIssue[];
  totals: {
    durationMinutes: number;
    transitMinutes: number;
    transitCost: number;
    distanceMeters: number;
    bufferMinutes: number;
  };
}

function parseMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function formatMinutes(value: number): string {
  const normalized = Math.max(0, Math.round(value));
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

export class ItineraryValidator {
  constructor(private readonly provider: DataProvider) {}

  async validate(input: {
    date: string;
    startTime: string;
    endTime: string;
    start: RoutePoint;
    endPolicy?: EndPolicy;
    end?: RoutePoint;
    stops: ItineraryStop[];
    legs: ItineraryLeg[];
    bufferMinutes?: number;
  }): Promise<ItineraryValidationResult> {
    const violations: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];
    const timeline: ProposedPlan["timeline"] = [];
    const startMinute = parseMinutes(input.startTime);
    const endMinute = parseMinutes(input.endTime);
    const endPolicy = input.endPolicy ?? "last_poi";
    const bufferMinutes = Math.max(0, Math.min(30, input.bufferMinutes ?? 10));
    if (startMinute === null || endMinute === null || endMinute <= startMinute) {
      violations.push({ code: "INVALID_TIME_WINDOW", message: "开始/结束时间必须是同一天内递增的 HH:MM" });
    }
    if (input.stops.length === 0) violations.push({ code: "NO_STOPS", message: "行程至少需要一个活动点" });
    if (endPolicy === "specified" && !input.end) {
      violations.push({ code: "MISSING_END_POINT", message: "endPolicy=specified 时必须提供终点" });
    }

    let cursor = startMinute ?? 0;
    let previousId = input.start.id;
    let transitMinutes = 0;
    let transitCost = 0;
    let distanceMeters = 0;
    let totalBuffer = 0;
    timeline.push({
      startTime: formatMinutes(cursor),
      endTime: formatMinutes(cursor),
      type: "departure",
      poiName: input.start.name,
      notes: "从确认的出发地出发",
    });

    for (const stop of input.stops) {
      const poi = await this.provider.getPoiById(stop.poiId);
      if (!poi) {
        violations.push({ code: "POI_NOT_FOUND", message: `找不到 POI ${stop.poiId}`, poiId: stop.poiId });
        continue;
      }
      const leg = input.legs.find((item) => item.fromId === previousId && item.toId === stop.poiId);
      if (!leg) {
        violations.push({ code: "MISSING_ROUTE", message: `缺少 ${previousId} 到 ${stop.poiId} 的路线`, poiId: stop.poiId });
      } else {
        const legStart = cursor;
        cursor += Math.max(1, leg.durationMinutes);
        transitMinutes += Math.max(1, leg.durationMinutes);
        transitCost += Math.max(0, leg.estimatedCost);
        distanceMeters += Math.max(0, leg.distanceMeters);
        timeline.push({
          startTime: formatMinutes(legStart),
          endTime: formatMinutes(cursor),
          type: "transit",
          poiName: poi.name,
          notes: `${leg.mode} ${(leg.distanceMeters / 1000).toFixed(1)}km，约 ${leg.durationMinutes} 分钟`,
        });
      }
      if (bufferMinutes > 0) {
        const bufferStart = cursor;
        cursor += bufferMinutes;
        totalBuffer += bufferMinutes;
        timeline.push({
          startTime: formatMinutes(bufferStart),
          endTime: formatMinutes(cursor),
          type: "rest",
          poiName: poi.name,
          notes: "排队/入场/换乘缓冲",
        });
      }
      const stopStart = cursor;
      cursor += Math.max(1, stop.durationMinutes);
      timeline.push({
        startTime: formatMinutes(stopStart),
        endTime: formatMinutes(cursor),
        type: stop.type,
        poiId: poi.id,
        poiName: poi.name,
        notes: stop.notes,
      });
      try {
        const opening = await this.provider.checkOpeningHours(poi.id, `${input.date}T${formatMinutes(stopStart)}:00`);
        if (opening.open === false) {
          violations.push({ code: "POI_CLOSED", message: `${poi.name} 在计划到访时间不营业: ${opening.reason}`, poiId: poi.id });
        } else if (opening.open === null) {
          warnings.push({ code: "OPENING_HOURS_UNKNOWN", message: `${poi.name} 营业时间无法自动确认: ${opening.reason}`, poiId: poi.id });
        }
      } catch (error) {
        warnings.push({ code: "OPENING_HOURS_CHECK_FAILED", message: `${poi.name} 营业时间校验失败: ${error instanceof Error ? error.message : error}`, poiId: poi.id });
      }
      if (stop.type === "meal" && !((stopStart >= 11 * 60 && stopStart <= 14 * 60) ||
          (stopStart >= 17 * 60 && stopStart <= 20 * 60 + 30))) {
        warnings.push({ code: "MEAL_TIME_UNUSUAL", message: `${poi.name} 的用餐开始时间 ${formatMinutes(stopStart)} 不在常见用餐时段`, poiId: poi.id });
      }
      previousId = poi.id;
    }

    const finalTarget = endPolicy === "return_to_start" ? input.start : endPolicy === "specified" ? input.end : undefined;
    if (finalTarget && previousId !== finalTarget.id) {
      const leg = input.legs.find((item) => item.fromId === previousId && item.toId === finalTarget.id);
      if (!leg) {
        violations.push({ code: "MISSING_END_ROUTE", message: `缺少最后活动点到终点 ${finalTarget.name} 的路线` });
      } else {
        const legStart = cursor;
        cursor += Math.max(1, leg.durationMinutes);
        transitMinutes += Math.max(1, leg.durationMinutes);
        transitCost += Math.max(0, leg.estimatedCost);
        distanceMeters += Math.max(0, leg.distanceMeters);
        timeline.push({
          startTime: formatMinutes(legStart),
          endTime: formatMinutes(cursor),
          type: "transit",
          poiName: finalTarget.name,
          notes: `${leg.mode}返回终点，约 ${leg.durationMinutes} 分钟`,
        });
      }
    }

    if (endMinute !== null && cursor > endMinute) {
      violations.push({ code: "TIME_WINDOW_EXCEEDED", message: `行程结束于 ${formatMinutes(cursor)}，超过用户要求的 ${input.endTime}` });
    }
    const canonical = JSON.stringify({ ...input, endPolicy, timeline });
    return {
      valid: violations.length === 0,
      validationToken: createHash("sha256").update(canonical).digest("hex").slice(0, 16),
      endPolicy,
      timeline,
      violations,
      warnings,
      totals: {
        durationMinutes: Math.max(0, cursor - (startMinute ?? 0)),
        transitMinutes,
        transitCost: Number(transitCost.toFixed(2)),
        distanceMeters,
        bufferMinutes: totalBuffer,
      },
    };
  }
}
