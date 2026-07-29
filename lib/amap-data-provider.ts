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
import type { TransitMode, RouteResult } from "./route-service";
import type { WeatherForecast } from "./weather-service";

const BASE_URL = "https://restapi.amap.com/v3";
const ACTIVITY_TYPE_PREFIXES = ["08", "10", "11", "14", "16"];

interface AmapPoi {
  id?: string;
  name?: string;
  adname?: string;
  cityname?: string;
  location?: string;
  type?: string;
  typecode?: string;
  address?: string;
  biz_ext?: { rating?: string; cost?: string; open_time?: string; opentime2?: string };
  business_hours?: string;
  tel?: string;
  business_area?: string;
  photos?: Array<{ title?: string; url?: string }>;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && value !== "[]";
}

function locationOf(value: string | undefined): { lng: number; lat: number } | undefined {
  if (!value) return undefined;
  const [lng, lat] = value.split(",").map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : undefined;
}

function numberOrNull(value: unknown): number | null {
  if (!present(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function openingHoursOf(poi: AmapPoi): string | null {
  const biz = poi.biz_ext;
  for (const value of [biz?.open_time, biz?.opentime2, poi.business_hours]) {
    if (present(value)) return String(value);
  }
  return null;
}

function modeName(mode: TransitMode): string {
  return mode === "walking" ? "步行" : mode === "transit" ? "公共交通" : mode === "bicycling" ? "骑行" : "驾车";
}

function categoryOf(typecode = ""): ProviderPoi["category"] {
  if (typecode.startsWith("05")) return "dining";
  if (typecode.startsWith("06")) return "shopping";
  if (typecode.startsWith("08") || typecode.startsWith("10")) return "entertainment";
  if (typecode.startsWith("11")) return "outdoor";
  return "cultural";
}

function weatherConditionOf(value: string, tempMax: number): WeatherForecast["condition"] {
  if (/雪/.test(value)) return "snowy";
  if (/雨|雷|冰雹/.test(value)) return "rainy";
  if (Number.isFinite(tempMax) && tempMax >= 35) return "hot";
  if (Number.isFinite(tempMax) && tempMax <= 5) return "cold";
  if (/晴/.test(value)) return "sunny";
  return "cloudy";
}

export class AmapDataProvider implements DataProvider {
  readonly kind = "amap" as const;
  private readonly poiCache = new Map<string, ProviderPoi>();

  constructor(private readonly apiKey: string, private readonly fallback: DataProvider) {}

  private async get<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = new URL(`${BASE_URL}/${path}`);
    url.searchParams.set("key", this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const body = await response.json() as { status?: string; info?: string } & T;
    if (!response.ok || body.status !== "1") throw new Error(`Amap ${path} failed: ${body.info ?? response.status}`);
    return body;
  }

  private async getV4<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
    const url = new URL(`https://restapi.amap.com/v4/${path}`);
    url.searchParams.set("key", this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const body = await response.json() as { errcode?: number; errmsg?: string } & T;
    if (!response.ok || body.errcode !== 0) throw new Error(`Amap v4 ${path} failed: ${body.errmsg ?? response.status}`);
    return body;
  }

  private remember(raw: AmapPoi, category: ProviderPoi["category"], city: string): ProviderPoi | undefined {
    const location = locationOf(raw.location);
    if (!raw.id || !raw.name || !location) return undefined;
    const poi: ProviderPoi = {
      id: raw.id, name: raw.name, city: raw.cityname || city, district: raw.adname || "",
      ...location, category, rating: numberOrNull(raw.biz_ext?.rating),
      // 高德 cost 对景点不具有"人均消费"语义，活动统一不写入预算链。
      pricePerPerson: category === "dining" ? numberOrNull(raw.biz_ext?.cost) : null,
      avgDurationHours: null, openingHours: openingHoursOf(raw),
      address: raw.address ?? "", typecode: raw.typecode, telephone: raw.tel,
      businessArea: raw.business_area,
      photos: (raw.photos ?? []).flatMap((photo) => photo.url ? [{ title: photo.title, url: photo.url }] : []),
      tags: [raw.typecode ?? "", raw.type ?? ""].filter(Boolean), description: raw.address ?? "",
      cuisine: category === "dining" ? raw.type : undefined,
      dietaryOptions: category === "dining" ? [] : undefined,
      signature: category === "dining" ? [] : undefined,
      source: "amap",
    };
    this.poiCache.set(poi.id, poi);
    return poi;
  }

  async locateIp(ip: string): Promise<IpLocationResult> {
    const data = await this.get<{ province?: string; city?: string | string[]; adcode?: string; rectangle?: string }>("ip", { ip });
    const city = Array.isArray(data.city) ? data.city[0] : data.city;
    if (!city) {
      return {
        available: false,
        accuracy: "unknown",
        canUseAsExactDeparture: false,
        source: "unavailable",
        reason: "高德未能根据该公网 IP 判断城市",
      };
    }
    return {
      available: true,
      province: data.province,
      city,
      adcode: data.adcode,
      rectangle: data.rectangle,
      accuracy: "city",
      canUseAsExactDeparture: false,
      source: "amap",
    };
  }

  async geocode(address: string, city?: string): Promise<GeocodeResult> {
    const data = await this.get<{ geocodes?: Array<{ location?: string; formatted_address?: string; city?: string | string[]; district?: string }> }>("geocode/geo", { address, city });
    const geocode = data.geocodes?.[0];
    const location = locationOf(geocode?.location);
    if (!location) throw new Error(`Amap did not find an address for ${address}`);
    const resolvedCity = Array.isArray(geocode?.city) ? geocode?.city[0] : geocode?.city;
    return { name: geocode?.formatted_address || address, city: resolvedCity || city || "", ...location, coordinateSystem: "GCJ-02", source: "amap" };
  }

  async reverseGeocode(location: { lng: number; lat: number }): Promise<GeocodeResult> {
    const data = await this.get<{
      regeocode?: {
        formatted_address?: string;
        addressComponent?: { city?: string | string[]; province?: string };
      };
    }>("geocode/regeo", { location: `${location.lng},${location.lat}`, extensions: "base" });
    const cityValue = data.regeocode?.addressComponent?.city;
    const city = (Array.isArray(cityValue) ? cityValue[0] : cityValue) ||
      data.regeocode?.addressComponent?.province || "";
    return {
      name: data.regeocode?.formatted_address || `${location.lng},${location.lat}`,
      city,
      ...location,
      coordinateSystem: "GCJ-02",
      source: "amap",
    };
  }

  private searchPage(
    queryType: PlaceSearchPage["queryType"],
    rawPois: AmapPoi[],
    page: number,
    pageSize: number,
    totalValue: string | undefined,
    excludePoiIds: string[] | undefined,
  ): PlaceSearchPage {
    const excluded = new Set(excludePoiIds ?? []);
    const pois = rawPois
      .map((raw) => this.remember(raw, categoryOf(raw.typecode), raw.cityname || ""))
      .filter((poi): poi is ProviderPoi => !!poi && !excluded.has(poi.id));
    const parsedTotal = Number(totalValue);
    const total = Number.isFinite(parsedTotal) ? parsedTotal : null;
    return {
      queryType,
      page,
      pageSize,
      total,
      hasMore: total === null ? rawPois.length >= pageSize : page * pageSize < total,
      pois,
      source: "amap",
    };
  }

  async searchPlacesText(query: PlaceSearchTextQuery): Promise<PlaceSearchPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(25, Math.max(1, query.pageSize ?? 20));
    const data = await this.get<{ count?: string; pois?: AmapPoi[] }>("place/text", {
      keywords: query.keywords.join("|"),
      city: query.city,
      citylimit: query.city ? "true" : "false",
      types: query.types?.join("|"),
      offset: pageSize,
      page,
      extensions: "all",
    });
    return this.searchPage("text", data.pois ?? [], page, pageSize, data.count, query.excludePoiIds);
  }

  async searchPlacesNearby(query: PlaceSearchNearbyQuery): Promise<PlaceSearchPage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(25, Math.max(1, query.pageSize ?? 20));
    const data = await this.get<{ count?: string; pois?: AmapPoi[] }>("place/around", {
      location: `${query.location.lng},${query.location.lat}`,
      keywords: query.keywords?.join("|"),
      types: query.types?.join("|"),
      radius: query.radiusMeters ?? 10_000,
      offset: pageSize,
      page,
      extensions: "all",
    });
    return this.searchPage("nearby", data.pois ?? [], page, pageSize, data.count, query.excludePoiIds);
  }

  async getPlaceDetails(ids: string[]): Promise<ProviderPoi[]> {
    const uniqueIds = [...new Set(ids)].slice(0, 10);
    const values = await Promise.all(uniqueIds.map((id) => this.getPoiById(id)));
    return values.filter((poi): poi is ProviderPoi => !!poi);
  }

  async getWeather(city: string, date: string): Promise<WeatherForecast> {
    const data = await this.get<{ forecasts?: Array<{ casts?: Array<{ date?: string; dayweather?: string; nightweather?: string; daytemp?: string; nighttemp?: string; daywind?: string }> }> }>("weather/weatherInfo", { city, extensions: "all" });
    const casts = data.forecasts?.[0]?.casts ?? [];
    const cast = casts.find((item) => item.date === date) ?? casts[0];
    if (!cast) throw new Error(`Amap did not return weather for ${city}`);
    const condition = cast.dayweather || cast.nightweather || "未知";
    const tempMax = Number(cast.daytemp);
    const tempMin = Number(cast.nighttemp);
    const suitableForOutdoor = !/雨|雪|暴雨|台风|霾|沙尘/.test(condition) && Number.isFinite(tempMax) && tempMax < 35;
    return {
      city, date: cast.date || date, condition: weatherConditionOf(condition, tempMax), description: condition,
      tempMax: Number.isFinite(tempMax) ? tempMax : 0, tempMin: Number.isFinite(tempMin) ? tempMin : 0,
      precipitation: null, windSpeed: null,
      advice: suitableForOutdoor ? "天气适宜出行" : "建议优先选择室内活动，并关注实时天气",
      suitableForOutdoor,
      source: "amap",
    };
  }

  private async search(query: ProviderSearchQuery, category: ProviderPoi["category"]): Promise<ProviderSearchResult[]> {
    const center = query.center ?? (await this.geocode(query.city, query.city));
    const keyword = category === "dining" ? (query.cuisine || "餐饮服务") : this.activityKeyword(query);
    const data = await this.get<{ pois?: AmapPoi[] }>("place/around", {
      location: `${center.lng},${center.lat}`, keywords: keyword, radius: query.radiusMeters ?? 10_000,
      offset: Math.min(Math.max((query.limit ?? 5) * 4, 10), 25), extensions: "all",
    });
    const isExpected = (poi: AmapPoi) => category === "dining"
      ? (poi.typecode ?? "").startsWith("05")
      : ACTIVITY_TYPE_PREFIXES.some((prefix) => (poi.typecode ?? "").startsWith(prefix));
    const candidates = (data.pois ?? []).filter(isExpected).map((raw) => this.remember(raw, category, query.city)).filter((poi): poi is ProviderPoi => !!poi);
    const filtered = candidates.filter((poi) =>
      (!query.district || poi.district === query.district) &&
      (poi.rating === null || !query.minRating || poi.rating >= query.minRating) &&
      (category !== "dining" || !query.budget || poi.pricePerPerson === null || (poi.pricePerPerson >= query.budget.min && poi.pricePerPerson <= query.budget.max)),
    );
    return filtered.slice(0, query.limit ?? 5).map((poi) => ({
      poi,
      distanceMeters: Math.round(this.distance(center, poi)),
      score: this.score(center, poi, query),
    }));
  }

  private activityKeyword(query: ProviderSearchQuery): string {
    if (query.category === "cultural") return "文化场馆";
    if (query.category === "shopping") return "商场";
    if (query.category === "entertainment") return "休闲娱乐";
    if (query.category === "outdoor") return "公园";
    return query.preferIndoor ? "文化场馆" : "旅游景点";
  }

  private distance(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
    const r = 6_371_000; const rad = (n: number) => n * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(h));
  }

  private score(center: { lng: number; lat: number }, poi: ProviderPoi, query: ProviderSearchQuery): number {
    const distanceScore = Math.max(0, 1 - this.distance(center, poi) / (query.radiusMeters ?? 10_000));
    const ratingScore = poi.rating === null ? 0.5 : Math.max(0, Math.min(1, (poi.rating - 3) / 2));
    return Number((0.55 * distanceScore + 0.45 * ratingScore).toFixed(3));
  }

  async searchActivities(query: ProviderSearchQuery): Promise<ProviderSearchResult[]> { return this.search(query, query.category ?? "cultural"); }
  async searchRestaurants(query: ProviderSearchQuery): Promise<ProviderSearchResult[]> { return this.search({ ...query, category: "dining" }, "dining"); }

  async getPoiById(id: string): Promise<ProviderPoi | undefined> {
    const cached = this.poiCache.get(id);
    if (cached) return cached;
    const data = await this.get<{ pois?: AmapPoi[] }>("place/detail", { id, extensions: "all" });
    const raw = data.pois?.[0];
    if (!raw) return undefined;
    const category = categoryOf(raw.typecode);
    return this.remember(raw, category, raw.cityname || "");
  }

  async checkOpeningHours(poiId: string, datetime: string): Promise<OpeningHoursResult> {
    const poi = await this.getPoiById(poiId);
    if (!poi) throw new Error(`POI ${poiId} not found`);
    if (!poi.openingHours) return { poiId, poiName: poi.name, datetime, open: null, hoursToday: null, reason: "高德未提供营业时间，需人工确认", source: "amap" };
    return { poiId, poiName: poi.name, datetime, open: null, hoursToday: poi.openingHours, reason: "高德返回营业时间；格式未标准化，需以商家实时信息为准", source: "amap" };
  }

  async computeRoute(from: RoutePoint, to: RoutePoint, preferredMode?: TransitMode): Promise<RouteResult> {
    const straightDistance = this.distance(from, to);
    const mode = preferredMode ?? (straightDistance < 1_000 ? "walking" : straightDistance < 8_000 ? "transit" : "driving");
    // 显式比较交通方式时必须保持请求的 mode；无公交方案由上层标记 unavailable，
    // 不能静默改成 walking，否则四模式比较会出现重复结果。
    const effectiveMode: TransitMode = mode;
    const origin = `${from.lng},${from.lat}`, destination = `${to.lng},${to.lat}`;
    if (effectiveMode === "bicycling") {
      const data = await this.getV4<{ data?: { paths?: Array<{ distance?: number; duration?: number }> } }>(
        "direction/bicycling",
        { origin, destination },
      );
      const route = data.data?.paths?.[0];
      if (!route) throw new Error("Amap returned no bicycling route");
      return this.routeResult(from, to, effectiveMode, String(route.distance ?? 0), String(route.duration ?? 0), "0");
    }
    if (effectiveMode === "transit") {
      const data = await this.get<{ route?: { transits?: Array<{ distance?: string; duration?: string; cost?: string }> } }>("direction/transit/integrated", {
        origin,
        destination,
        city: from.city,
        cityd: to.city ?? from.city,
      });
      const route = data.route?.transits?.[0];
      if (!route) throw new Error("Amap returned no transit route for this leg");
      return this.routeResult(from, to, effectiveMode, route.distance, route.duration, route.cost);
    }
    const endpoint = effectiveMode === "walking" ? "direction/walking" : "direction/driving";
    const data = await this.get<{ route?: { paths?: Array<{ distance?: string; duration?: string; tolls?: string }> } }>(endpoint, { origin, destination });
    const route = data.route?.paths?.[0];
    if (!route) throw new Error(`Amap returned no ${effectiveMode} route`);
    return this.routeResult(from, to, effectiveMode, route.distance, route.duration, route.tolls);
  }

  private routeResult(from: { id: string }, to: { id: string }, mode: TransitMode, distance?: string, duration?: string, cost?: string): RouteResult {
    const distanceMeters = Math.round(Number(distance) || 0), durationMinutes = Math.max(1, Math.round((Number(duration) || 0) / 60));
    const rawCost = Number(cost);
    const km = distanceMeters / 1000;
    const estimatedCost = mode === "driving"
      ? Math.max(12, Math.ceil(km * 2.5)) + (Number.isFinite(rawCost) ? rawCost : 0)
      : mode === "transit"
        ? (Number.isFinite(rawCost) && rawCost > 0 ? rawCost : Math.max(3, Math.ceil(km * 0.5)))
        : 0;
    return {
      fromId: from.id,
      toId: to.id,
      mode,
      distanceMeters,
      durationMinutes,
      estimatedCost,
      description: `${modeName(mode)} ${(distanceMeters / 1000).toFixed(1)}km，约 ${durationMinutes} 分钟`,
      source: "amap",
      costConfidence: mode === "walking" || mode === "bicycling"
        ? "exact"
        : mode === "transit" && Number.isFinite(rawCost) && rawCost > 0
          ? "exact"
          : "estimate",
      tolls: mode === "driving" ? (Number.isFinite(rawCost) ? rawCost : 0) : undefined,
    };
  }

  async computeDistanceMatrix(points: RoutePoint[], mode: DistanceMatrixMode): Promise<DistanceMatrixEntry[]> {
    const entries: DistanceMatrixEntry[] = [];
    const type = mode === "walking" ? 3 : mode === "driving" ? 1 : 0;
    for (const destination of points) {
      const origins = points.filter((point) => point.id !== destination.id);
      if (origins.length === 0) continue;
      const data = await this.get<{
        results?: Array<{ origin_id?: string; distance?: string; duration?: string }>;
      }>("distance", {
        origins: origins.map((point) => `${point.lng},${point.lat}`).join("|"),
        destination: `${destination.lng},${destination.lat}`,
        type,
      });
      for (const [index, result] of (data.results ?? []).entries()) {
        // 高德 origin_id 从 1 开始；结果顺序与 origins 输入顺序一致。
        const originIndex = Number(result.origin_id) - 1;
        const origin = origins[Number.isInteger(originIndex) && originIndex >= 0 ? originIndex : index] ?? origins[index];
        if (!origin) continue;
        entries.push({
          fromId: origin.id,
          toId: destination.id,
          distanceMeters: Math.round(Number(result.distance) || 0),
          durationMinutes: mode === "straight" ? null : Math.max(1, Math.round((Number(result.duration) || 0) / 60)),
          source: "amap",
        });
      }
    }
    if (entries.length !== points.length * Math.max(0, points.length - 1)) {
      throw new Error(`Amap distance matrix incomplete: ${entries.length} entries for ${points.length} points`);
    }
    return entries;
  }
}
