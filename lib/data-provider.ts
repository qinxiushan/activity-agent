import type { TransitMode, RouteResult } from "./route-service";
import type { WeatherForecast } from "./weather-service";

export type ProviderKind = "mock" | "amap";

export interface ProviderPoi {
  id: string;
  name: string;
  city: string;
  district: string;
  lng: number;
  lat: number;
  category: "outdoor" | "cultural" | "shopping" | "entertainment" | "dining";
  rating: number | null;
  pricePerPerson: number | null;
  avgDurationHours: number | null;
  openingHours: string | null;
  address?: string;
  typecode?: string;
  telephone?: string;
  businessArea?: string;
  photos?: Array<{ title?: string; url: string }>;
  tags: string[];
  description: string;
  cuisine?: string;
  dietaryOptions?: string[];
  signature?: string[];
  source: ProviderKind;
}

export interface ProviderSearchQuery {
  city: string;
  district?: string;
  category?: ProviderPoi["category"];
  cuisine?: string;
  budget?: { min: number; max: number };
  minRating?: number;
  radiusMeters?: number;
  center?: { lng: number; lat: number };
  limit?: number;
  preferIndoor?: boolean;
  dietary?: string[];
}

export interface ProviderSearchResult {
  poi: ProviderPoi;
  distanceMeters: number;
  score: number;
}

export interface IpLocationResult {
  available: boolean;
  province?: string;
  city?: string;
  adcode?: string;
  rectangle?: string;
  accuracy: "city" | "unknown";
  canUseAsExactDeparture: false;
  source: ProviderKind | "unavailable";
  reason?: string;
}

export interface PlaceSearchTextQuery {
  keywords: string[];
  city?: string;
  types?: string[];
  page?: number;
  pageSize?: number;
  excludePoiIds?: string[];
}

export interface PlaceSearchNearbyQuery {
  location: { lng: number; lat: number };
  keywords?: string[];
  types?: string[];
  radiusMeters?: number;
  page?: number;
  pageSize?: number;
  excludePoiIds?: string[];
}

export interface PlaceSearchPage {
  queryType: "text" | "nearby";
  page: number;
  pageSize: number;
  total: number | null;
  hasMore: boolean;
  pois: ProviderPoi[];
  source: ProviderKind;
}

export interface GeocodeResult {
  name: string;
  city: string;
  lng: number;
  lat: number;
  coordinateSystem: "GCJ-02";
  source: ProviderKind;
}

export interface OpeningHoursResult {
  poiId: string;
  poiName: string;
  datetime: string;
  open: boolean | null;
  hoursToday: string | null;
  reason: string;
  source: ProviderKind;
}

export type DistanceMatrixMode = "straight" | "walking" | "driving";

export interface RoutePoint {
  id: string;
  name: string;
  city?: string;
  lng: number;
  lat: number;
}

export interface DistanceMatrixEntry {
  fromId: string;
  toId: string;
  distanceMeters: number;
  durationMinutes: number | null;
  source: ProviderKind;
}

export interface DataProvider {
  readonly kind: ProviderKind;
  locateIp(ip: string): Promise<IpLocationResult>;
  getWeather(city: string, date: string): Promise<WeatherForecast>;
  geocode(address: string, city?: string): Promise<GeocodeResult>;
  reverseGeocode(location: { lng: number; lat: number }): Promise<GeocodeResult>;
  searchPlacesText(query: PlaceSearchTextQuery): Promise<PlaceSearchPage>;
  searchPlacesNearby(query: PlaceSearchNearbyQuery): Promise<PlaceSearchPage>;
  getPlaceDetails(ids: string[]): Promise<ProviderPoi[]>;
  searchActivities(query: ProviderSearchQuery): Promise<ProviderSearchResult[]>;
  searchRestaurants(query: ProviderSearchQuery): Promise<ProviderSearchResult[]>;
  getPoiById(id: string): Promise<ProviderPoi | undefined>;
  checkOpeningHours(poiId: string, datetime: string): Promise<OpeningHoursResult>;
  computeRoute(
    from: RoutePoint,
    to: RoutePoint,
    mode?: TransitMode,
  ): Promise<RouteResult>;
  computeDistanceMatrix(points: RoutePoint[], mode: DistanceMatrixMode): Promise<DistanceMatrixEntry[]>;
}
