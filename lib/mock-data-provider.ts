import { getCityCenter, getPOIById, searchPOIs, type POIQuery } from "./poi-database";
import { isOpenAt, parseHoursString } from "./opening-hours-service";
import { computeRoute, haversineMeters, type TransitMode, type RouteResult } from "./route-service";
import { getWeather, type WeatherForecast } from "./weather-service";
import type {
  DataProvider,
  GeocodeResult,
  IpLocationResult,
  OpeningHoursResult,
  PlaceSearchNearbyQuery,
  PlaceSearchPage,
  PlaceSearchTextQuery,
  ProviderPoi,
  ProviderSearchQuery,
  ProviderSearchResult,
  DistanceMatrixEntry,
  DistanceMatrixMode,
  RoutePoint,
} from "./data-provider";

function toProviderPoi(poi: NonNullable<ReturnType<typeof getPOIById>>): ProviderPoi {
  return {
    id: poi.id, name: poi.name, city: poi.city, district: poi.district,
    lng: poi.lng, lat: poi.lat, category: poi.category, rating: poi.rating,
    pricePerPerson: poi.pricePerPerson, avgDurationHours: poi.avgDuration,
    openingHours: poi.openingHours, tags: poi.tags, description: poi.description,
    cuisine: poi.category === "dining" ? poi.cuisine : undefined,
    dietaryOptions: poi.category === "dining" ? poi.dietaryOptions : undefined,
    signature: poi.category === "dining" ? poi.signature : undefined,
    source: "mock",
  };
}

function toSearchQuery(query: ProviderSearchQuery): POIQuery {
  return {
    city: query.city, district: query.district, category: query.category,
    cuisine: query.cuisine as POIQuery["cuisine"], budget: query.budget,
    minRating: query.minRating, radiusMeters: query.radiusMeters,
    center: query.center, limit: query.limit, dietary: query.dietary as POIQuery["dietary"],
  };
}

export class MockDataProvider implements DataProvider {
  readonly kind = "mock" as const;

  async locateIp(_ip: string): Promise<IpLocationResult> {
    return {
      available: false,
      accuracy: "unknown",
      canUseAsExactDeparture: false,
      source: "unavailable",
      reason: "mock 数据源不提供 IP 定位",
    };
  }

  async getWeather(city: string, date: string): Promise<WeatherForecast> {
    return { ...getWeather(city, date), source: "mock" };
  }

  async geocode(address: string, city?: string): Promise<GeocodeResult> {
    const resolvedCity = city ?? address;
    const center = getCityCenter(resolvedCity);
    if (!center) throw new Error(`Mock provider does not support geocoding ${address}`);
    return { name: address, city: resolvedCity, ...center, coordinateSystem: "GCJ-02", source: "mock" };
  }

  async reverseGeocode(location: { lng: number; lat: number }): Promise<GeocodeResult> {
    const cities = ["北京", "上海", "深圳"];
    const nearest = cities
      .map((city) => ({ city, center: getCityCenter(city)! }))
      .sort((a, b) => Math.hypot(a.center.lng - location.lng, a.center.lat - location.lat) -
        Math.hypot(b.center.lng - location.lng, b.center.lat - location.lat))[0];
    if (!nearest) throw new Error("Mock provider cannot reverse geocode this location");
    return {
      name: `${nearest.city}附近`,
      city: nearest.city,
      ...location,
      coordinateSystem: "GCJ-02",
      source: "mock",
    };
  }

  async searchPlacesText(query: PlaceSearchTextQuery): Promise<PlaceSearchPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(25, Math.max(1, query.pageSize ?? 20));
    const excluded = new Set(query.excludePoiIds ?? []);
    const needles = query.keywords.map((item) => item.trim().toLowerCase()).filter(Boolean);
    const all = searchPOIs({ city: query.city ?? "北京", limit: 100 })
      .map((result) => toProviderPoi(result.poi))
      .filter((poi) => !excluded.has(poi.id))
      .filter((poi) => needles.length === 0 || needles.some((needle) =>
        `${poi.name} ${poi.tags.join(" ")} ${poi.description}`.toLowerCase().includes(needle)));
    const start = (page - 1) * pageSize;
    return {
      queryType: "text",
      page,
      pageSize,
      total: all.length,
      hasMore: start + pageSize < all.length,
      pois: all.slice(start, start + pageSize),
      source: "mock",
    };
  }

  async searchPlacesNearby(query: PlaceSearchNearbyQuery): Promise<PlaceSearchPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(25, Math.max(1, query.pageSize ?? 20));
    const excluded = new Set(query.excludePoiIds ?? []);
    const keywords = (query.keywords ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean);
    const all = ["北京", "上海", "深圳"].flatMap((city) =>
      searchPOIs({ city, center: query.location, radiusMeters: query.radiusMeters ?? 10_000, limit: 100 }))
      .map((result) => toProviderPoi(result.poi))
      .filter((poi) => !excluded.has(poi.id))
      .filter((poi) => keywords.length === 0 || keywords.some((keyword) =>
        `${poi.name} ${poi.tags.join(" ")} ${poi.description}`.toLowerCase().includes(keyword)));
    const start = (page - 1) * pageSize;
    return {
      queryType: "nearby",
      page,
      pageSize,
      total: all.length,
      hasMore: start + pageSize < all.length,
      pois: all.slice(start, start + pageSize),
      source: "mock",
    };
  }

  async getPlaceDetails(ids: string[]): Promise<ProviderPoi[]> {
    const uniqueIds = [...new Set(ids)].slice(0, 10);
    const values = await Promise.all(uniqueIds.map((id) => this.getPoiById(id)));
    return values.filter((poi): poi is ProviderPoi => !!poi);
  }

  async searchActivities(query: ProviderSearchQuery): Promise<ProviderSearchResult[]> {
    let results = searchPOIs(toSearchQuery(query));
    if (query.preferIndoor) results = results.filter((r) => r.poi.category === "cultural" || r.poi.category === "shopping");
    return results.map((r) => ({ poi: toProviderPoi(r.poi), distanceMeters: r.distanceMeters, score: r.score }));
  }

  async searchRestaurants(query: ProviderSearchQuery): Promise<ProviderSearchResult[]> {
    return searchPOIs(toSearchQuery({ ...query, category: "dining" }))
      .map((r) => ({ poi: toProviderPoi(r.poi), distanceMeters: r.distanceMeters, score: r.score }));
  }

  async getPoiById(id: string): Promise<ProviderPoi | undefined> {
    const poi = getPOIById(id);
    return poi ? toProviderPoi(poi) : undefined;
  }

  async checkOpeningHours(poiId: string, datetime: string): Promise<OpeningHoursResult> {
    const poi = await this.getPoiById(poiId);
    if (!poi) throw new Error(`POI ${poiId} not found`);
    const result = isOpenAt(parseHoursString(poi.openingHours ?? "-"), new Date(datetime));
    return { poiId, poiName: poi.name, datetime, open: result.open, hoursToday: result.hoursToday, reason: result.reason, source: "mock" };
  }

  async computeRoute(from: RoutePoint, to: RoutePoint, mode?: TransitMode): Promise<RouteResult> {
    return computeRoute(from, to, mode);
  }

  async computeDistanceMatrix(points: RoutePoint[], mode: DistanceMatrixMode): Promise<DistanceMatrixEntry[]> {
    const entries: DistanceMatrixEntry[] = [];
    for (const from of points) {
      for (const to of points) {
        if (from.id === to.id) continue;
        if (mode === "straight") {
          entries.push({
            fromId: from.id,
            toId: to.id,
            distanceMeters: Math.round(haversineMeters(from, to)),
            durationMinutes: null,
            source: "mock",
          });
        } else {
          const route = computeRoute(from, to, mode);
          entries.push({
            fromId: from.id,
            toId: to.id,
            distanceMeters: route.distanceMeters,
            durationMinutes: route.durationMinutes,
            source: "mock",
          });
        }
      }
    }
    return entries;
  }
}
