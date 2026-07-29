import { createHash } from "node:crypto";
import type { DataProvider } from "./data-provider";
import type { TransitMode } from "./route-service";
import {
  CostResolver,
  type CostEstimateSource,
  type ReserveStrategy,
  type ResolvedUnitCost,
} from "./cost-resolver";

export type CostCategory = "activity" | "dining" | "transport" | "reserve";
export type CostConfidence = "exact" | "estimate" | "unknown";
export type BudgetStatus = "within" | "near_limit" | "exceeded";

export interface BudgetStop {
  poiId: string;
  type: "activity" | "meal";
}

export interface BudgetLeg {
  fromId: string;
  toId: string;
  mode: TransitMode;
  estimatedCost: number;
  costConfidence?: CostConfidence;
}

export interface BudgetItem {
  id: string;
  category: CostCategory;
  label: string;
  amount: number;
  perPersonAmount: number;
  quantity: number;
  confidence: CostConfidence;
  source: CostEstimateSource | "route_estimate";
  originalPriceKnown: boolean;
  priceRange: ResolvedUnitCost;
  minimumAmount: number;
  likelyAmount: number;
  maximumAmount: number;
  poiId?: string;
  route?: { fromId: string; toId: string; mode: TransitMode };
  note: string;
}

export interface BudgetBreakdown {
  currency: "CNY";
  partySize: number;
  budgetPerPerson: number;
  budgetLimit: number;
  knownTotal: number;
  estimatedTotal: number;
  reserveTotal: number;
  minimumTotal: number;
  likelyTotal: number;
  maximumTotal: number;
  projectedTotal: number;
  projectedPerPerson: number;
  remaining: number;
  status: BudgetStatus;
  completeness: number;
  unknownPriceCount: number;
  reserveStrategy: ReserveStrategy;
  assumptions: string[];
  items: BudgetItem[];
}

export interface BudgetCalculationResult {
  valid: true;
  budgetToken: string;
  breakdown: BudgetBreakdown;
}

function money(value: number): number {
  return Number(Math.max(0, value).toFixed(2));
}

function signedMoney(value: number): number {
  return Number(value.toFixed(2));
}

export class BudgetService {
  constructor(private readonly provider: DataProvider) {}

  async calculate(input: {
    partySize: number;
    budgetPerPerson: number;
    stops: BudgetStop[];
    legs: BudgetLeg[];
    reserveStrategy?: ReserveStrategy;
  }): Promise<BudgetCalculationResult> {
    const partySize = Math.max(1, Math.floor(input.partySize));
    const budgetPerPerson = money(input.budgetPerPerson);
    const reserveStrategy = input.reserveStrategy ?? "balanced";
    const resolver = new CostResolver(this.provider);
    const items: BudgetItem[] = [];
    const assumptions = [
      `未知价格优先采用同区域可比 POI，其次采用城市/类别价格区间；当前策略 ${reserveStrategy}`,
      "价格区间和 planningReserve 是规划估算，不表示真实票价或真实消费",
      "公交按人计费；驾车按整段车辆成本估算；步行和骑行按 ¥0",
    ];

    for (const stop of input.stops) {
      const poi = await this.provider.getPoiById(stop.poiId);
      if (!poi) throw new Error(`POI ${stop.poiId} not found while calculating budget`);
      const isDining = stop.type === "meal" || poi.category === "dining";
      const price = await resolver.resolve(poi, isDining, reserveStrategy);
      items.push({
        id: `${isDining ? "dining" : "activity"}:${poi.id}`,
        category: isDining ? "dining" : "activity",
        label: poi.name,
        amount: money(price.planningReserve * partySize),
        perPersonAmount: price.planningReserve,
        quantity: partySize,
        confidence: price.status === "exact" ? "exact" : price.status === "estimated" ? "estimate" : "unknown",
        source: price.source,
        originalPriceKnown: price.status === "exact",
        priceRange: price,
        minimumAmount: money(price.low * partySize),
        likelyAmount: money(price.likely * partySize),
        maximumAmount: money(price.high * partySize),
        poiId: poi.id,
        note: price.basis,
      });
    }

    for (const [index, leg] of input.legs.entries()) {
      const perPersonMode = leg.mode === "transit";
      const amount = money(Math.max(0, leg.estimatedCost) * (perPersonMode ? partySize : 1));
      const confidence = leg.costConfidence ?? (
        leg.mode === "walking" || leg.mode === "bicycling" ? "exact" : "estimate"
      );
      const multiplier = confidence === "exact" ? { low: 1, likely: 1, high: 1 } :
        confidence === "estimate" ? { low: 0.8, likely: 1, high: 1.35 } :
          { low: 0.5, likely: 1, high: 1.6 };
      const range: ResolvedUnitCost = {
        status: confidence === "exact" ? "exact" : confidence === "estimate" ? "estimated" : "unresolved",
        low: money(leg.estimatedCost * multiplier.low),
        likely: money(leg.estimatedCost * multiplier.likely),
        high: money(leg.estimatedCost * multiplier.high),
        planningReserve: money(leg.estimatedCost),
        source: "generic_fallback",
        confidence: confidence === "exact" ? "high" : confidence === "estimate" ? "medium" : "unknown",
        basis: "路线服务返回的交通费用及其误差区间",
      };
      items.push({
        id: `transport:${index}:${leg.fromId}:${leg.toId}`,
        category: "transport",
        label: `${leg.fromId} 到 ${leg.toId} (${leg.mode})`,
        amount,
        perPersonAmount: money(amount / partySize),
        quantity: perPersonMode ? partySize : 1,
        confidence,
        source: "route_estimate",
        originalPriceKnown: true,
        priceRange: range,
        minimumAmount: money(range.low * (perPersonMode ? partySize : 1)),
        likelyAmount: money(range.likely * (perPersonMode ? partySize : 1)),
        maximumAmount: money(range.high * (perPersonMode ? partySize : 1)),
        route: { fromId: leg.fromId, toId: leg.toId, mode: leg.mode },
        note: perPersonMode
          ? "公共交通按每人票价计算"
          : leg.mode === "driving"
            ? "驾车按整段车辆成本估算；停车费可能未包含"
            : "非机动车通勤费用",
      });
    }

    const knownTotal = money(items
      .filter((item) => item.confidence === "exact")
      .reduce((sum, item) => sum + item.amount, 0));
    const estimatedTotal = money(items
      .filter((item) => item.confidence === "estimate")
      .reduce((sum, item) => sum + item.amount, 0));
    const reserveTotal = money(items
      .filter((item) => item.confidence === "unknown")
      .reduce((sum, item) => sum + item.amount, 0));
    const minimumTotal = money(items.reduce((sum, item) => sum + item.minimumAmount, 0));
    const likelyTotal = money(items.reduce((sum, item) => sum + item.likelyAmount, 0));
    const maximumTotal = money(items.reduce((sum, item) => sum + item.maximumAmount, 0));
    const projectedTotal = money(knownTotal + estimatedTotal + reserveTotal);
    const budgetLimit = money(budgetPerPerson * partySize);
    const remaining = signedMoney(budgetLimit - projectedTotal);
    const ratio = budgetLimit > 0 ? projectedTotal / budgetLimit : 1;
    const status: BudgetStatus = projectedTotal > budgetLimit
      ? "exceeded"
      : ratio >= 0.9
        ? "near_limit"
        : "within";
    const priceBearingItems = items.filter((item) => item.category !== "transport" || item.amount > 0);
    const knownOrEstimatedCount = priceBearingItems.filter((item) => item.originalPriceKnown).length;
    const completeness = priceBearingItems.length === 0
      ? 1
      : Number((knownOrEstimatedCount / priceBearingItems.length).toFixed(3));
    const breakdown: BudgetBreakdown = {
      currency: "CNY",
      partySize,
      budgetPerPerson,
      budgetLimit,
      knownTotal,
      estimatedTotal,
      reserveTotal,
      minimumTotal,
      likelyTotal,
      maximumTotal,
      projectedTotal,
      projectedPerPerson: money(projectedTotal / partySize),
      remaining,
      status,
      completeness,
      unknownPriceCount: items.filter((item) => !item.originalPriceKnown).length,
      reserveStrategy,
      assumptions,
      items,
    };
    const budgetToken = createHash("sha256")
      .update(JSON.stringify(breakdown))
      .digest("hex")
      .slice(0, 16);
    return { valid: true, budgetToken, breakdown };
  }
}
