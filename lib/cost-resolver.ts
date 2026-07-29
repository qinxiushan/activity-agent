import type { DataProvider, ProviderPoi, ProviderKind } from "./data-provider";

export type ReserveStrategy = "minimal" | "balanced" | "conservative";
export type CostEstimateSource =
  | ProviderKind
  | "comparable_pois"
  | "category_prior"
  | "generic_fallback";

export interface ResolvedUnitCost {
  status: "exact" | "estimated" | "unresolved";
  low: number;
  likely: number;
  high: number;
  planningReserve: number;
  source: CostEstimateSource;
  confidence: "high" | "medium" | "low" | "unknown";
  basis: string;
  sampleSize?: number;
}

export function hasAdaptivePriceRange(
  value: unknown,
): value is { low: number; high: number } {
  if (!value || typeof value !== "object") return false;
  const range = value as { low?: unknown; high?: unknown };
  return typeof range.low === "number" && Number.isFinite(range.low) &&
    typeof range.high === "number" && Number.isFinite(range.high);
}

type Prior = { low: number; likely: number; high: number; label: string };

const PRIORS: Record<string, Prior> = {
  park: { low: 0, likely: 10, high: 40, label: "城市公园/公共空间" },
  public_museum: { low: 0, likely: 30, high: 80, label: "公立博物馆/纪念馆" },
  private_exhibition: { low: 50, likely: 120, high: 220, label: "商业展览/私立美术馆" },
  theme_park: { low: 250, likely: 450, high: 700, label: "主题乐园" },
  zoo_aquarium: { low: 80, likely: 180, high: 350, label: "动物园/海洋馆" },
  performance: { low: 100, likely: 300, high: 800, label: "演出/剧场" },
  hands_on: { low: 80, likely: 180, high: 320, label: "手作/体验活动" },
  shopping: { low: 0, likely: 0, high: 50, label: "商场/街区自由活动" },
  dining: { low: 60, likely: 120, high: 220, label: "普通正餐" },
};

function money(value: number): number {
  return Number(Math.max(0, value).toFixed(2));
}

function chooseReserve(
  range: Pick<ResolvedUnitCost, "low" | "likely" | "high">,
  strategy: ReserveStrategy,
): number {
  return strategy === "minimal" ? range.low : strategy === "conservative" ? range.high : range.likely;
}

function quantile(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

function cityFactor(city: string): number {
  if (/北京|上海|深圳|广州|香港|澳门/.test(city)) return 1.15;
  if (/杭州|南京|苏州|成都|重庆|武汉|天津|西安|厦门/.test(city)) return 1.05;
  return 1;
}

export function inferCostPriorKey(poi: ProviderPoi, isDining: boolean): keyof typeof PRIORS | undefined {
  if (isDining) return "dining";
  const text = `${poi.name} ${poi.description} ${poi.tags.join(" ")}`.toLowerCase();
  if (/迪士尼|环球影城|主题乐园|欢乐谷|游乐园/.test(text)) return "theme_park";
  if (/动物园|海洋馆|水族馆/.test(text)) return "zoo_aquarium";
  // 名称和高德类型中常会同时出现馆内剧场、演出厅等附属设施。
  // 对主体为博物馆/纪念馆的 POI，公共文化场馆语义应优先于附属演出设施。
  if (/博物馆|纪念馆|科技馆|文化馆/.test(text)) return "public_museum";
  if (/美术馆|艺术中心|展览|画廊/.test(text)) return "private_exhibition";
  if (/剧院|剧场|演出|音乐厅|livehouse/.test(text)) return "performance";
  if (/手作|陶艺|烘焙|体验|工作坊/.test(text)) return "hands_on";
  if (/公园|广场|绿道|湿地|植物园/.test(text) || poi.category === "outdoor") return "park";
  if (/商场|购物|步行街|街区|太古里|天地/.test(text) || poi.category === "shopping") return "shopping";
  return undefined;
}

export class CostResolver {
  constructor(private readonly provider: DataProvider) {}

  async resolve(
    poi: ProviderPoi,
    isDining: boolean,
    strategy: ReserveStrategy,
  ): Promise<ResolvedUnitCost> {
    if (poi.pricePerPerson !== null) {
      const value = money(poi.pricePerPerson);
      return {
        status: "exact",
        low: value,
        likely: value,
        high: value,
        planningReserve: value,
        source: poi.source,
        confidence: "high",
        basis: isDining ? "POI 返回的人均消费" : "POI 返回的门票/活动价格",
      };
    }

    const comparablePrices = await this.findComparablePrices(poi, isDining);
    if (comparablePrices.length >= 3) {
      const range = {
        low: money(quantile(comparablePrices, 0.25)),
        likely: money(quantile(comparablePrices, 0.5)),
        high: money(quantile(comparablePrices, 0.75)),
      };
      return {
        status: "estimated",
        ...range,
        planningReserve: chooseReserve(range, strategy),
        source: "comparable_pois",
        confidence: comparablePrices.length >= 8 ? "medium" : "low",
        basis: `${poi.city}${poi.district}附近同类 POI 的 P25/P50/P75 价格`,
        sampleSize: comparablePrices.length,
      };
    }

    const key = inferCostPriorKey(poi, isDining);
    if (key) {
      const prior = PRIORS[key]!;
      const factor = cityFactor(poi.city);
      const range = {
        low: money(prior.low * factor),
        likely: money(prior.likely * factor),
        high: money(prior.high * factor),
      };
      return {
        status: "estimated",
        ...range,
        planningReserve: chooseReserve(range, strategy),
        source: "category_prior",
        confidence: "low",
        basis: `${poi.city || "当前城市"}${prior.label}价格先验（城市系数 ${factor}）`,
      };
    }

    const factor = cityFactor(poi.city);
    const base = isDining
      ? { low: 50, likely: 120, high: 260 }
      : { low: 0, likely: 120, high: 350 };
    const range = {
      low: money(base.low * factor),
      likely: money(base.likely * factor),
      high: money(base.high * factor),
    };
    return {
      status: "unresolved",
      ...range,
      planningReserve: chooseReserve(range, strategy),
      source: "generic_fallback",
      confidence: "unknown",
      basis: "无真实价格、可比样本或明确类别，仅使用宽区间安全兜底",
    };
  }

  private async findComparablePrices(poi: ProviderPoi, isDining: boolean): Promise<number[]> {
    try {
      const results = isDining
        ? await this.provider.searchRestaurants({
            city: poi.city,
            district: poi.district || undefined,
            cuisine: poi.cuisine,
            center: { lng: poi.lng, lat: poi.lat },
            radiusMeters: 8_000,
            limit: 20,
          })
        : await this.provider.searchActivities({
            city: poi.city,
            district: poi.district || undefined,
            category: poi.category,
            center: { lng: poi.lng, lat: poi.lat },
            radiusMeters: 8_000,
            limit: 20,
          });
      return results
        .map((result) => result.poi.pricePerPerson)
        .filter((price): price is number => price !== null && Number.isFinite(price) && price >= 0);
    } catch {
      return [];
    }
  }
}
