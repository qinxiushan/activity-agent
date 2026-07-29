import fs from "node:fs";
import type {
  DataProvider,
  DistanceMatrixEntry,
  DistanceMatrixMode,
  GeocodeResult,
  IpLocationResult,
  OpeningHoursResult,
  PlaceSearchNearbyQuery,
  PlaceSearchPage,
  PlaceSearchTextQuery,
  ProviderKind,
  ProviderPoi,
  ProviderSearchQuery,
  ProviderSearchResult,
  RoutePoint,
} from "../data-provider";
import type { RouteResult, TransitMode } from "../route-service";
import type { WeatherForecast } from "../weather-service";

export type ReplayOperation =
  | "locateIp"
  | "getWeather"
  | "geocode"
  | "reverseGeocode"
  | "searchPlacesText"
  | "searchPlacesNearby"
  | "getPlaceDetails"
  | "searchActivities"
  | "searchRestaurants"
  | "getPoiById"
  | "checkOpeningHours"
  | "computeRoute"
  | "computeDistanceMatrix";

export interface ReplayRecord {
  request?: unknown;
  response?: unknown;
  error?: string;
}

export interface ReplayFixture {
  version: "eval-replay-v1";
  id: string;
  providerKind: ProviderKind;
  strictRequests?: boolean;
  onMissing?: "error" | "fallback";
  operations: Partial<Record<ReplayOperation, ReplayRecord[]>>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class ReplayDataProvider implements DataProvider {
  readonly kind: ProviderKind;
  private readonly cursors = new Map<ReplayOperation, number>();

  constructor(
    readonly fixture: ReplayFixture,
    private readonly fallback?: DataProvider,
  ) {
    if (fixture.version !== "eval-replay-v1") {
      throw new Error(`Unsupported replay fixture version: ${fixture.version}`);
    }
    if (fixture.onMissing === "fallback" && !fallback) {
      throw new Error(`Replay fixture ${fixture.id} requires a fallback provider`);
    }
    this.kind = fixture.providerKind;
  }

  static fromFile(filePath: string, fallback?: DataProvider): ReplayDataProvider {
    const fixture = JSON.parse(fs.readFileSync(filePath, "utf8")) as ReplayFixture;
    return new ReplayDataProvider(fixture, fallback);
  }

  reset(): void {
    this.cursors.clear();
  }

  remaining(operation: ReplayOperation): number {
    const records = this.fixture.operations[operation] ?? [];
    return Math.max(0, records.length - (this.cursors.get(operation) ?? 0));
  }

  private async replay<T>(
    operation: ReplayOperation,
    request: unknown,
    fallbackCall?: () => Promise<T>,
  ): Promise<T> {
    const records = this.fixture.operations[operation] ?? [];
    const index = this.cursors.get(operation) ?? 0;
    const record = records[index];
    if (!record) {
      if (this.fixture.onMissing === "fallback" && fallbackCall) return fallbackCall();
      throw new Error(`Replay fixture ${this.fixture.id} exhausted operation ${operation} at call ${index + 1}`);
    }
    this.cursors.set(operation, index + 1);
    if (this.fixture.strictRequests && record.request !== undefined &&
        stable(record.request) !== stable(request)) {
      throw new Error(
        `Replay request mismatch for ${operation} call ${index + 1}: ` +
        `expected ${stable(record.request)}, received ${stable(request)}`,
      );
    }
    if (record.error) throw new Error(record.error);
    return clone(record.response as T);
  }

  locateIp(ip: string): Promise<IpLocationResult> {
    return this.replay("locateIp", { ip }, () => this.fallback!.locateIp(ip));
  }
  getWeather(city: string, date: string): Promise<WeatherForecast> {
    return this.replay("getWeather", { city, date }, () => this.fallback!.getWeather(city, date));
  }
  geocode(address: string, city?: string): Promise<GeocodeResult> {
    return this.replay("geocode", { address, city }, () => this.fallback!.geocode(address, city));
  }
  reverseGeocode(location: { lng: number; lat: number }): Promise<GeocodeResult> {
    return this.replay("reverseGeocode", { location }, () => this.fallback!.reverseGeocode(location));
  }
  searchPlacesText(query: PlaceSearchTextQuery): Promise<PlaceSearchPage> {
    return this.replay("searchPlacesText", query, () => this.fallback!.searchPlacesText(query));
  }
  searchPlacesNearby(query: PlaceSearchNearbyQuery): Promise<PlaceSearchPage> {
    return this.replay("searchPlacesNearby", query, () => this.fallback!.searchPlacesNearby(query));
  }
  getPlaceDetails(ids: string[]): Promise<ProviderPoi[]> {
    return this.replay("getPlaceDetails", { ids }, () => this.fallback!.getPlaceDetails(ids));
  }
  searchActivities(query: ProviderSearchQuery): Promise<ProviderSearchResult[]> {
    return this.replay("searchActivities", query, () => this.fallback!.searchActivities(query));
  }
  searchRestaurants(query: ProviderSearchQuery): Promise<ProviderSearchResult[]> {
    return this.replay("searchRestaurants", query, () => this.fallback!.searchRestaurants(query));
  }
  getPoiById(id: string): Promise<ProviderPoi | undefined> {
    return this.replay("getPoiById", { id }, () => this.fallback!.getPoiById(id));
  }
  checkOpeningHours(poiId: string, datetime: string): Promise<OpeningHoursResult> {
    return this.replay(
      "checkOpeningHours",
      { poiId, datetime },
      () => this.fallback!.checkOpeningHours(poiId, datetime),
    );
  }
  computeRoute(from: RoutePoint, to: RoutePoint, mode?: TransitMode): Promise<RouteResult> {
    return this.replay("computeRoute", { from, to, mode }, () => this.fallback!.computeRoute(from, to, mode));
  }
  computeDistanceMatrix(
    points: RoutePoint[],
    mode: DistanceMatrixMode,
  ): Promise<DistanceMatrixEntry[]> {
    return this.replay(
      "computeDistanceMatrix",
      { points, mode },
      () => this.fallback!.computeDistanceMatrix(points, mode),
    );
  }
}
