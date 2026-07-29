import type { ProviderKind } from "./data-provider";

export type DataActualSource = ProviderKind | "mixed" | "unavailable";
export type DataFreshness = "live" | "synthetic" | "unknown";
export type DataConfidence = "high" | "medium" | "low" | "unknown";

export interface DataQuality {
  operation: string;
  requestedSource: ProviderKind;
  actualSource: DataActualSource;
  freshness: DataFreshness;
  confidence: DataConfidence;
  degraded: boolean;
  degradationReason?: string;
  missingFields: string[];
  retrievedAt: string;
}

const QUALITY = Symbol("activity-agent.data-quality");
type QualityCarrier = object & { [QUALITY]?: DataQuality };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectSources(value: unknown, depth = 0): Set<DataActualSource> {
  const sources = new Set<DataActualSource>();
  if (depth > 4 || !isObject(value)) return sources;
  const source = value.source;
  if (source === "amap" || source === "mock" || source === "unavailable") sources.add(source);
  const values = Array.isArray(value) ? value : Object.values(value);
  for (const child of values.slice(0, 100)) {
    for (const nested of collectSources(child, depth + 1)) sources.add(nested);
  }
  return sources;
}

function inferActualSource(value: unknown, requestedSource: ProviderKind): DataActualSource {
  const sources = collectSources(value);
  if (sources.size === 0) return requestedSource;
  if (sources.size > 1) return "mixed";
  return [...sources][0]!;
}

function inferMissingFields(operation: string, value: unknown): string[] {
  if (!isObject(value)) return [];
  if (operation === "weather") {
    return ["precipitation", "windSpeed"].filter((field) => value[field] === null || value[field] === undefined);
  }
  if (operation === "opening_hours") {
    return [
      value.open === null || value.open === undefined ? "open" : "",
      value.hoursToday === null || value.hoursToday === undefined ? "hoursToday" : "",
    ].filter(Boolean);
  }
  if (operation === "place_details") {
    const places = Array.isArray(value) ? value : Array.isArray(value.places) ? value.places : [];
    const missing = new Set<string>();
    for (const place of places) {
      if (!isObject(place)) continue;
      if (place.rating === null || place.rating === undefined) missing.add("rating");
      if (place.pricePerPerson === null || place.averageCostPerPerson === null) missing.add("price");
      if (place.openingHours === null || place.openingHours === undefined) missing.add("openingHours");
    }
    return [...missing];
  }
  return [];
}

function inferConfidence(
  actualSource: DataActualSource,
  missingFields: string[],
  degraded: boolean,
): DataConfidence {
  if (actualSource === "unavailable") return "unknown";
  if (actualSource === "mock" || degraded || actualSource === "mixed") return "low";
  return missingFields.length > 0 ? "medium" : "high";
}

export function attachDataQuality<T>(
  value: T,
  quality: Omit<DataQuality, "retrievedAt"> & { retrievedAt?: string },
): T {
  if (!isObject(value)) return value;
  Object.defineProperty(value, QUALITY, {
    configurable: true,
    enumerable: false,
    value: {
      ...quality,
      retrievedAt: quality.retrievedAt ?? new Date().toISOString(),
    } satisfies DataQuality,
  });
  return value;
}

export function assessDataQuality(
  operation: string,
  value: unknown,
  requestedSource: ProviderKind,
): DataQuality {
  const attached = isObject(value) ? (value as QualityCarrier)[QUALITY] : undefined;
  if (attached) {
    const missingFields = [...new Set([...attached.missingFields, ...inferMissingFields(operation, value)])];
    return {
      ...attached,
      operation,
      missingFields,
      confidence: inferConfidence(attached.actualSource, missingFields, attached.degraded),
    };
  }
  const actualSource = inferActualSource(value, requestedSource);
  const missingFields = inferMissingFields(operation, value);
  const degraded = actualSource !== requestedSource;
  return {
    operation,
    requestedSource,
    actualSource,
    freshness: actualSource === "amap" ? "live" : actualSource === "mock" ? "synthetic" : "unknown",
    confidence: inferConfidence(actualSource, missingFields, degraded),
    degraded,
    degradationReason: degraded ? `requested ${requestedSource}, received ${actualSource}` : undefined,
    missingFields,
    retrievedAt: new Date().toISOString(),
  };
}

export function attachFallbackQuality<T>(
  operation: string,
  value: T,
  requestedSource: ProviderKind,
  error: unknown,
): T {
  const actualSource = inferActualSource(value, "mock");
  const missingFields = inferMissingFields(operation, value);
  return attachDataQuality(value, {
    operation,
    requestedSource,
    actualSource,
    freshness: actualSource === "mock" ? "synthetic" : "unknown",
    confidence: "low",
    degraded: true,
    degradationReason: error instanceof Error ? error.message : String(error),
    missingFields,
  });
}
