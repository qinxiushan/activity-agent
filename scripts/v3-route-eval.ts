import fs from "node:fs";
import path from "node:path";
import { AmapDataProvider } from "../lib/amap-data-provider";
import { MockDataProvider } from "../lib/mock-data-provider";
import { ItineraryValidator } from "../lib/itinerary-validator";
import { RoutePlanningService } from "../lib/route-planning-service";
import { BudgetService } from "../lib/budget-service";

function loadKey(): string {
  if (process.env.AMAP_MAPS_API_KEY) return process.env.AMAP_MAPS_API_KEY;
  const env = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  const match = env.match(/^AMAP_MAPS_API_KEY\s*=\s*(.+)$/m);
  if (!match) throw new Error("AMAP_MAPS_API_KEY 未设置");
  return match[1]!.trim().replace(/^["']|["']$/g, "");
}

async function main(): Promise<void> {
  const provider = new AmapDataProvider(loadKey(), new MockDataProvider());
  const routeService = new RoutePlanningService(provider);
  const startGeo = await provider.geocode("广州塔", "广州");
  const museumSearch = await provider.searchPlacesText({
    city: "广州",
    keywords: ["广东省博物馆"],
    pageSize: 5,
  });
  const museum = museumSearch.pois.find((poi) => poi.name.includes("广东省博物馆")) ?? museumSearch.pois[0];
  if (!museum) throw new Error("未找到广东省博物馆");
  const islandGeo = await provider.geocode("沙面岛", "广州");
  const start = { id: "start", name: startGeo.name, city: "广州", lng: startGeo.lng, lat: startGeo.lat };
  const museumPoint = { id: museum.id, name: museum.name, city: museum.city, lng: museum.lng, lat: museum.lat };
  const island = { id: "island", name: islandGeo.name, city: "广州", lng: islandGeo.lng, lat: islandGeo.lat };

  const comparison = await routeService.compare(start, museumPoint, {
    modes: ["walking", "transit", "driving", "bicycling"],
    priority: "balanced",
    weatherCondition: "晴",
  });
  const matrix = await routeService.matrix([start, museumPoint, island], "driving", "start");
  const selected = comparison.options
    .filter((option) => option.available)
    .sort((a, b) => ("score" in a ? a.score : Infinity) - ("score" in b ? b.score : Infinity))[0];
  if (!selected || !selected.available) throw new Error("没有可用路线");
  const validation = await new ItineraryValidator(provider).validate({
    date: "2026-08-01",
    startTime: "10:00",
    endTime: "14:00",
    start,
    endPolicy: "last_poi",
    stops: [{ poiId: museum.id, type: "activity", durationMinutes: 120 }],
    legs: [{
      fromId: "start",
      toId: museum.id,
      mode: selected.mode,
      distanceMeters: selected.distanceMeters,
      durationMinutes: selected.durationMinutes,
      estimatedCost: selected.estimatedCost,
    }],
    bufferMinutes: 10,
  });
  const budget = await new BudgetService(provider).calculate({
    partySize: 2,
    budgetPerPerson: 300,
    stops: [{ poiId: museum.id, type: "activity" }],
    legs: [{
      fromId: "start",
      toId: museum.id,
      mode: selected.mode,
      estimatedCost: selected.estimatedCost,
      costConfidence: selected.costConfidence,
    }],
  });
  const report = {
    comparison: {
      from: start.name,
      to: museum.name,
      recommendedMode: comparison.recommendedMode,
      options: comparison.options.map((option) => option.available
        ? {
            mode: option.mode,
            available: true,
            distanceMeters: option.distanceMeters,
            durationMinutes: option.durationMinutes,
            estimatedCost: option.estimatedCost,
            source: option.source,
          }
        : option),
    },
    matrix: {
      entryCount: matrix.entries.length,
      suggestedOrder: matrix.suggestedOrder,
      totalDistanceMeters: matrix.totalDistanceMeters,
      sources: [...new Set(matrix.entries.map((entry) => entry.source))],
    },
    validation: {
      valid: validation.valid,
      violations: validation.violations,
      warnings: validation.warnings,
      timelineEntries: validation.timeline.length,
      totals: validation.totals,
    },
    budget: {
      knownTotal: budget.breakdown.knownTotal,
      estimatedTotal: budget.breakdown.estimatedTotal,
      reserveTotal: budget.breakdown.reserveTotal,
      projectedTotal: budget.breakdown.projectedTotal,
      projectedPerPerson: budget.breakdown.projectedPerPerson,
      remaining: budget.breakdown.remaining,
      status: budget.breakdown.status,
      completeness: budget.breakdown.completeness,
      unknownOriginalPrices: budget.breakdown.items
        .filter((item) => !item.originalPriceKnown)
        .map((item) => ({
          label: item.label,
          range: [item.priceRange.low, item.priceRange.high],
          planningReserve: item.priceRange.planningReserve,
          source: item.priceRange.source,
          confidence: item.priceRange.confidence,
          basis: item.priceRange.basis,
        })),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  const availableModes = comparison.options.filter((option) => option.available);
  const modeResultsHonest = comparison.options.every((option, index) =>
    option.mode === ["walking", "transit", "driving", "bicycling"][index]);
  if (availableModes.length < 3 ||
      !modeResultsHonest ||
      availableModes.some((option) => option.available && option.source !== "amap") ||
      matrix.entries.length !== 6 ||
      matrix.entries.some((entry) => entry.source !== "amap") ||
      !validation.valid ||
      budget.breakdown.unknownPriceCount < 1 ||
      budget.breakdown.minimumTotal > budget.breakdown.likelyTotal ||
      budget.breakdown.likelyTotal > budget.breakdown.maximumTotal ||
      budget.breakdown.projectedTotal !== budget.breakdown.knownTotal +
        budget.breakdown.estimatedTotal + budget.breakdown.reserveTotal) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
