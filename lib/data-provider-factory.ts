import type {
  DataProvider,
  GeocodeResult,
  IpLocationResult,
  OpeningHoursResult,
  PlaceSearchNearbyQuery,
  PlaceSearchPage,
  PlaceSearchTextQuery,
  ProviderSearchQuery,
  ProviderSearchResult,
  DistanceMatrixEntry,
  DistanceMatrixMode,
  RoutePoint,
} from "./data-provider";
import { MockDataProvider } from "./mock-data-provider";
import { AmapDataProvider } from "./amap-data-provider";
import type { TransitMode, RouteResult } from "./route-service";
import type { WeatherForecast } from "./weather-service";
import { attachFallbackQuality } from "./data-quality";
import { ReplayDataProvider } from "./eval/replay-provider";

const mockProvider = new MockDataProvider();
let amapProvider: AmapDataProvider | undefined;
let resilientAmapProvider: DataProvider | undefined;
let replayProvider: ReplayDataProvider | undefined;
let replayProviderPath: string | undefined;

export type DataFallbackPolicy = "allow_mock" | "fail_closed";

export interface DataProviderStatus {
  requestedSource: "mock" | "amap";
  activeSource: "mock" | "amap" | "unavailable";
  fallbackPolicy: DataFallbackPolicy;
  configured: boolean;
  warning?: string;
}

export function getDataFallbackPolicy(): DataFallbackPolicy {
  const configured = process.env.DATA_FALLBACK_POLICY;
  if (configured === "allow_mock" || configured === "fail_closed") return configured;
  return process.env.NODE_ENV === "production" ? "fail_closed" : "allow_mock";
}

export function getDataProviderStatus(): DataProviderStatus {
  const replayPath = process.env.DATA_REPLAY_FIXTURE;
  if (replayPath) {
    try {
      const provider = getReplayProvider(replayPath);
      return {
        requestedSource: provider.kind,
        activeSource: provider.kind,
        fallbackPolicy: "fail_closed",
        configured: true,
        warning: `deterministic replay fixture: ${provider.fixture.id}`,
      };
    } catch (error) {
      return {
        requestedSource: "mock",
        activeSource: "unavailable",
        fallbackPolicy: "fail_closed",
        configured: false,
        warning: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const requestedSource = process.env.DATA_SOURCE === "amap" ? "amap" : "mock";
  const fallbackPolicy = getDataFallbackPolicy();
  if (requestedSource === "mock") {
    return { requestedSource, activeSource: "mock", fallbackPolicy, configured: true };
  }
  if (!process.env.AMAP_MAPS_API_KEY) {
    return {
      requestedSource,
      activeSource: fallbackPolicy === "allow_mock" ? "mock" : "unavailable",
      fallbackPolicy,
      configured: false,
      warning: "DATA_SOURCE=amap but AMAP_MAPS_API_KEY is missing",
    };
  }
  return { requestedSource, activeSource: "amap", fallbackPolicy, configured: true };
}

class FallbackDataProvider implements DataProvider {
  readonly kind = "amap" as const;
  constructor(private readonly primary: DataProvider, private readonly fallback: DataProvider) {}
  private async use<T>(operation: string, primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try { return await primary(); } catch (error) {
      console.warn("[data-provider] amap failed; falling back to mock:", error instanceof Error ? error.message : error);
      return attachFallbackQuality(operation, await fallback(), "amap", error);
    }
  }
  locateIp(ip: string): Promise<IpLocationResult> { return this.use("ip_location", () => this.primary.locateIp(ip), () => this.fallback.locateIp(ip)); }
  getWeather(city: string, date: string): Promise<WeatherForecast> { return this.use("weather", () => this.primary.getWeather(city, date), () => this.fallback.getWeather(city, date)); }
  geocode(address: string, city?: string): Promise<GeocodeResult> { return this.use("geocode", () => this.primary.geocode(address, city), () => this.fallback.geocode(address, city)); }
  reverseGeocode(location: { lng: number; lat: number }): Promise<GeocodeResult> { return this.use("reverse_geocode", () => this.primary.reverseGeocode(location), () => this.fallback.reverseGeocode(location)); }
  searchPlacesText(query: PlaceSearchTextQuery): Promise<PlaceSearchPage> { return this.use("place_search_text", () => this.primary.searchPlacesText(query), () => this.fallback.searchPlacesText(query)); }
  searchPlacesNearby(query: PlaceSearchNearbyQuery): Promise<PlaceSearchPage> { return this.use("place_search_nearby", () => this.primary.searchPlacesNearby(query), () => this.fallback.searchPlacesNearby(query)); }
  getPlaceDetails(ids: string[]) { return this.use("place_details", () => this.primary.getPlaceDetails(ids), () => this.fallback.getPlaceDetails(ids)); }
  searchActivities(query: ProviderSearchQuery): Promise<ProviderSearchResult[]> { return this.use("activity_search", () => this.primary.searchActivities(query), () => this.fallback.searchActivities(query)); }
  searchRestaurants(query: ProviderSearchQuery): Promise<ProviderSearchResult[]> { return this.use("restaurant_search", () => this.primary.searchRestaurants(query), () => this.fallback.searchRestaurants(query)); }
  getPoiById(id: string) { return this.use("place_detail", () => this.primary.getPoiById(id), () => this.fallback.getPoiById(id)); }
  checkOpeningHours(poiId: string, datetime: string): Promise<OpeningHoursResult> { return this.use("opening_hours", () => this.primary.checkOpeningHours(poiId, datetime), () => this.fallback.checkOpeningHours(poiId, datetime)); }
  // 路线和矩阵不能用 mock 冒充真实结果；失败应由上层显示为 unavailable。
  computeRoute(from: RoutePoint, to: RoutePoint, mode?: TransitMode): Promise<RouteResult> { return this.primary.computeRoute(from, to, mode); }
  computeDistanceMatrix(points: RoutePoint[], mode: DistanceMatrixMode): Promise<DistanceMatrixEntry[]> { return this.primary.computeDistanceMatrix(points, mode); }
}

export function getDataProvider(): DataProvider {
  const replayPath = process.env.DATA_REPLAY_FIXTURE;
  if (replayPath) return getReplayProvider(replayPath);
  const status = getDataProviderStatus();
  if (status.requestedSource === "mock") return mockProvider;
  if (!status.configured) {
    if (status.fallbackPolicy === "fail_closed") throw new Error(status.warning);
    return mockProvider;
  }
  const apiKey = process.env.AMAP_MAPS_API_KEY;
  if (!apiKey) throw new Error("AMAP_MAPS_API_KEY became unavailable after provider validation");
  amapProvider ??= new AmapDataProvider(apiKey, mockProvider);
  if (status.fallbackPolicy === "fail_closed") return amapProvider;
  resilientAmapProvider ??= new FallbackDataProvider(amapProvider, mockProvider);
  return resilientAmapProvider;
}

export function resetDataProviderForTests(): void {
  amapProvider = undefined;
  resilientAmapProvider = undefined;
  replayProvider = undefined;
  replayProviderPath = undefined;
}

function getReplayProvider(filePath: string): ReplayDataProvider {
  if (!replayProvider || replayProviderPath !== filePath) {
    replayProvider = ReplayDataProvider.fromFile(filePath, mockProvider);
    replayProviderPath = filePath;
  }
  return replayProvider;
}
