import fs from "node:fs";
import path from "node:path";
import { BudgetService } from "../lib/budget-service";
import {
  ItineraryValidator,
  type ItineraryLeg,
  type ItineraryValidationResult,
} from "../lib/itinerary-validator";
import { MockDataProvider } from "../lib/mock-data-provider";
import {
  RoutePlanningService,
  type RouteComparison,
  type RoutePriority,
} from "../lib/route-planning-service";
import type { ProviderPoi } from "../lib/data-provider";

interface ScenarioResult {
  id: string;
  validItinerary: boolean;
  allRouteModesAvailable: boolean;
  budgetInvariantValid: boolean;
  sourceDisclosed: boolean;
  estimatesExplained: boolean;
  budgetStatus: string;
  warnings: number;
  violationCodes: string[];
}

interface QualityDataset {
  version: string;
  axes: {
    cities: string[];
    partySizes: number[];
    budgetsPerPerson: number[];
    routePriorities: RoutePriority[];
    weatherConditions: string[];
  };
  constraints: {
    date: string;
    startTime: string;
    endTime: string;
    endPolicy: "last_poi";
    activityDurationMinutes: number;
    mealDurationMinutes: number;
    bufferMinutes: number;
    requiredRouteModes: Array<"walking" | "transit" | "driving" | "bicycling">;
  };
  qualityGates: {
    minimumScenarioCount: number;
    minimumValidItineraryRate: number;
    minimumRouteAvailabilityRate: number;
    minimumBudgetInvariantRate: number;
    minimumSourceDisclosureRate: number;
    minimumEstimateExplanationRate: number;
  };
}

const dataset = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), "evals/v5-service-scenarios.json"), "utf8"),
) as QualityDataset;

function rate(values: boolean[]): number {
  return Number((values.filter(Boolean).length / Math.max(1, values.length)).toFixed(4));
}

async function evaluateScenario(
  provider: MockDataProvider,
  city: string,
  partySize: number,
  budgetPerPerson: number,
  index: number,
): Promise<ScenarioResult> {
  const startGeo = await provider.geocode(city, city);
  const activityGroups = await Promise.all(
    (["cultural", "entertainment", "outdoor", "shopping"] as const).map((category) =>
      provider.searchActivities({ city, category, center: startGeo, limit: 10 })),
  );
  const activities = activityGroups.flat();
  const restaurants = await provider.searchRestaurants({
    city,
    center: startGeo,
    limit: 10,
  });
  const openActivities = [];
  for (const candidate of activities) {
    const opening = await provider.checkOpeningHours(candidate.poi.id, `${dataset.constraints.date}T11:00:00`);
    if (opening.open !== false) openActivities.push(candidate);
  }
  const openRestaurants = [];
  for (const candidate of restaurants) {
    const opening = await provider.checkOpeningHours(candidate.poi.id, `${dataset.constraints.date}T13:00:00`);
    if (opening.open !== false) openRestaurants.push(candidate);
  }
  const start = { id: "start", name: `${city}中心`, city, lng: startGeo.lng, lat: startGeo.lat };
  const routeService = new RoutePlanningService(provider);
  type CandidatePlan = {
    activity: ProviderPoi;
    restaurant: ProviderPoi;
    first: RouteComparison;
    second: RouteComparison;
    legs: ItineraryLeg[];
    validation: ItineraryValidationResult;
  };
  let candidatePlan: CandidatePlan | undefined;
  let lastAttempt: CandidatePlan | undefined;
  const activityChoices = [...openActivities.slice(index % Math.max(1, openActivities.length)), ...openActivities].slice(0, 5);
  const restaurantStart = (index * 3) % Math.max(1, openRestaurants.length);
  const restaurantChoices = [...openRestaurants.slice(restaurantStart), ...openRestaurants].slice(0, 5);
  for (const activityCandidate of activityChoices) {
    for (const restaurantCandidate of restaurantChoices) {
      const activity = activityCandidate.poi;
      const restaurant = restaurantCandidate.poi;
      const activityPoint = {
        id: activity.id, name: activity.name, city: activity.city, lng: activity.lng, lat: activity.lat,
      };
      const restaurantPoint = {
        id: restaurant.id, name: restaurant.name, city: restaurant.city, lng: restaurant.lng, lat: restaurant.lat,
      };
      const first = await routeService.compare(start, activityPoint, {
        modes: dataset.constraints.requiredRouteModes,
        priority: dataset.axes.routePriorities[index % dataset.axes.routePriorities.length],
        weatherCondition: dataset.axes.weatherConditions[index % dataset.axes.weatherConditions.length],
        maxWalkingMinutes: 30,
      });
      const second = await routeService.compare(activityPoint, restaurantPoint, {
        modes: dataset.constraints.requiredRouteModes,
        priority: dataset.axes.routePriorities[(index + 1) % dataset.axes.routePriorities.length],
        weatherCondition: dataset.axes.weatherConditions[index % dataset.axes.weatherConditions.length],
        maxWalkingMinutes: 30,
      });
      const selected = [first, second].map((comparison) =>
        comparison.options.find((option) => option.available && option.mode === comparison.recommendedMode));
      if (!selected[0]?.available || !selected[1]?.available) continue;
      const legs: ItineraryLeg[] = [
        {
          fromId: "start", toId: activity.id, mode: selected[0].mode,
          distanceMeters: selected[0].distanceMeters, durationMinutes: selected[0].durationMinutes,
          estimatedCost: selected[0].estimatedCost,
        },
        {
          fromId: activity.id, toId: restaurant.id, mode: selected[1].mode,
          distanceMeters: selected[1].distanceMeters, durationMinutes: selected[1].durationMinutes,
          estimatedCost: selected[1].estimatedCost,
        },
      ];
      const validation = await new ItineraryValidator(provider).validate({
        date: dataset.constraints.date,
        startTime: dataset.constraints.startTime,
        endTime: dataset.constraints.endTime,
        start,
        endPolicy: dataset.constraints.endPolicy,
        stops: [
          { poiId: activity.id, type: "activity", durationMinutes: dataset.constraints.activityDurationMinutes },
          { poiId: restaurant.id, type: "meal", durationMinutes: dataset.constraints.mealDurationMinutes },
        ],
        legs,
        bufferMinutes: dataset.constraints.bufferMinutes,
      });
      lastAttempt = { activity, restaurant, first, second, legs, validation };
      if (validation.valid) {
        candidatePlan = lastAttempt;
        break;
      }
    }
    if (candidatePlan) break;
  }
  candidatePlan ??= lastAttempt;
  if (!candidatePlan) throw new Error(`${city} lacks a routable activity/dining combination`);
  const { activity, restaurant, first, second, legs, validation } = candidatePlan;
  const budget = await new BudgetService(provider).calculate({
    partySize,
    budgetPerPerson,
    stops: [
      { poiId: activity.id, type: "activity" },
      { poiId: restaurant.id, type: "meal" },
    ],
    legs,
    reserveStrategy: budgetPerPerson <= 300 ? "conservative" : "balanced",
  });
  const breakdown = budget.breakdown;
  const options = [...first.options, ...second.options];
  return {
    id: `${city}-${partySize}-${budgetPerPerson}`,
    validItinerary: validation.valid,
    allRouteModesAvailable: options.length === 8 && options.every((option) => option.available),
    budgetInvariantValid:
      breakdown.minimumTotal <= breakdown.likelyTotal &&
      breakdown.likelyTotal <= breakdown.maximumTotal &&
      breakdown.projectedTotal === breakdown.knownTotal + breakdown.estimatedTotal + breakdown.reserveTotal &&
      breakdown.projectedPerPerson === Number((breakdown.projectedTotal / partySize).toFixed(2)),
    sourceDisclosed:
      options.every((option) => !option.available || option.source === "mock") &&
      budget.breakdown.items.every((item) => typeof item.source === "string" && item.source.length > 0),
    estimatesExplained: budget.breakdown.items
      .filter((item) => item.confidence !== "exact")
      .every((item) =>
        item.priceRange.low <= item.priceRange.likely &&
        item.priceRange.likely <= item.priceRange.high &&
        item.priceRange.basis.length > 0),
    budgetStatus: breakdown.status,
    warnings: validation.warnings.length,
    violationCodes: validation.violations.map((issue) => issue.code),
  };
}

async function main(): Promise<void> {
  const provider = new MockDataProvider();
  const scenarios: ScenarioResult[] = [];
  let index = 0;
  for (const city of dataset.axes.cities) {
    for (const partySize of dataset.axes.partySizes) {
      for (const budget of dataset.axes.budgetsPerPerson) {
        scenarios.push(await evaluateScenario(provider, city, partySize, budget, index++));
      }
    }
  }
  const metrics = {
    datasetVersion: dataset.version,
    scenarioCount: scenarios.length,
    validItineraryRate: rate(scenarios.map((item) => item.validItinerary)),
    routeAvailabilityRate: rate(scenarios.map((item) => item.allRouteModesAvailable)),
    budgetInvariantRate: rate(scenarios.map((item) => item.budgetInvariantValid)),
    sourceDisclosureRate: rate(scenarios.map((item) => item.sourceDisclosed)),
    estimateExplanationRate: rate(scenarios.map((item) => item.estimatesExplained)),
    budgetStatusDistribution: Object.fromEntries(
      ["within", "near_limit", "exceeded"].map((status) => [
        status,
        scenarios.filter((item) => item.budgetStatus === status).length,
      ]),
    ),
    warningScenarioCount: scenarios.filter((item) => item.warnings > 0).length,
    violationDistribution: Object.fromEntries(
      [...new Set(scenarios.flatMap((item) => item.violationCodes))].map((code) => [
        code,
        scenarios.filter((item) => item.violationCodes.includes(code)).length,
      ]),
    ),
  };
  const gates = {
    scenarioCount: metrics.scenarioCount >= dataset.qualityGates.minimumScenarioCount,
    validItineraryRate: metrics.validItineraryRate >= dataset.qualityGates.minimumValidItineraryRate,
    routeAvailabilityRate: metrics.routeAvailabilityRate >= dataset.qualityGates.minimumRouteAvailabilityRate,
    budgetInvariantRate: metrics.budgetInvariantRate >= dataset.qualityGates.minimumBudgetInvariantRate,
    sourceDisclosureRate: metrics.sourceDisclosureRate >= dataset.qualityGates.minimumSourceDisclosureRate,
    estimateExplanationRate: metrics.estimateExplanationRate >= dataset.qualityGates.minimumEstimateExplanationRate,
  };
  console.log(JSON.stringify({ metrics, gates }, null, 2));
  if (Object.values(gates).some((passed) => !passed)) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 2;
});
