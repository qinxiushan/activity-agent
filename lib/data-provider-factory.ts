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

const mockProvider = new MockDataProvider();
let amapProvider: AmapDataProvider | undefined;
let resilientAmapProvider: DataProvider | undefined;

class FallbackDataProvider implements DataProvider {
  readonly kind = "amap" as const;
  constructor(private readonly primary: DataProvider, private readonly fallback: DataProvider) {}
  private async use<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    try { return await primary(); } catch (error) {
      console.warn("[data-provider] amap failed; falling back to mock:", error instanceof Error ? error.message : error);
      return fallback();
    }
  }
  locateIp(ip: string): Promise<IpLocationResult> { return this.use(() => this.primary.locateIp(ip), () => this.fallback.locateIp(ip)); }
  getWeather(city: string, date: string): Promise<WeatherForecast> { return this.use(() => this.primary.getWeather(city, date), () => this.fallback.getWeather(city, date)); }
  geocode(address: string, city?: string): Promise<GeocodeResult> { return this.use(() => this.primary.geocode(address, city), () => this.fallback.geocode(address, city)); }
  reverseGeocode(location: { lng: number; lat: number }): Promise<GeocodeResult> { return this.use(() => this.primary.reverseGeocode(location), () => this.fallback.reverseGeocode(location)); }
  searchPlacesText(query: PlaceSearchTextQuery): Promise<PlaceSearchPage> { return this.use(() => this.primary.searchPlacesText(query), () => this.fallback.searchPlacesText(query)); }
  searchPlacesNearby(query: PlaceSearchNearbyQuery): Promise<PlaceSearchPage> { return this.use(() => this.primary.searchPlacesNearby(query), () => this.fallback.searchPlacesNearby(query)); }
  getPlaceDetails(ids: string[]) { return this.use(() => this.primary.getPlaceDetails(ids), () => this.fallback.getPlaceDetails(ids)); }
  searchActivities(query: ProviderSearchQuery): Promise<ProviderSearchResult[]> { return this.use(() => this.primary.searchActivities(query), () => this.fallback.searchActivities(query)); }
  searchRestaurants(query: ProviderSearchQuery): Promise<ProviderSearchResult[]> { return this.use(() => this.primary.searchRestaurants(query), () => this.fallback.searchRestaurants(query)); }
  getPoiById(id: string) { return this.use(() => this.primary.getPoiById(id), () => this.fallback.getPoiById(id)); }
  checkOpeningHours(poiId: string, datetime: string): Promise<OpeningHoursResult> { return this.use(() => this.primary.checkOpeningHours(poiId, datetime), () => this.fallback.checkOpeningHours(poiId, datetime)); }
  // 路线和矩阵不能用 mock 冒充真实结果；失败应由上层显示为 unavailable。
  computeRoute(from: RoutePoint, to: RoutePoint, mode?: TransitMode): Promise<RouteResult> { return this.primary.computeRoute(from, to, mode); }
  computeDistanceMatrix(points: RoutePoint[], mode: DistanceMatrixMode): Promise<DistanceMatrixEntry[]> { return this.primary.computeDistanceMatrix(points, mode); }
}

export function getDataProvider(): DataProvider {
  if (process.env.DATA_SOURCE !== "amap") return mockProvider;
  if (!process.env.AMAP_MAPS_API_KEY) return mockProvider;
  amapProvider ??= new AmapDataProvider(process.env.AMAP_MAPS_API_KEY, mockProvider);
  resilientAmapProvider ??= new FallbackDataProvider(amapProvider, mockProvider);
  return resilientAmapProvider;
}
