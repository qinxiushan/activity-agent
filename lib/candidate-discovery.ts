import type {
  DataProvider,
  PlaceSearchPage,
  ProviderPoi,
} from "./data-provider";
import type { DataActualSource } from "./data-quality";

export type CandidateCategory = "activity" | "dining" | "mixed";
export type CandidateSearchMode = "text" | "nearby";

export interface CandidateDiscoveryInput {
  city: string;
  center: { lng: number; lat: number };
  keywords: string[];
  types?: string[];
  category?: CandidateCategory;
  radiusMeters?: number;
  candidateCount?: number;
  diversityWeight?: number;
  excludePoiIds?: string[];
  modes?: CandidateSearchMode[];
}

export interface CandidateInput {
  poi: ProviderPoi;
  keyword: string;
  mode: CandidateSearchMode;
}

export interface RankedCandidate {
  poi: ProviderPoi;
  rank: number;
  relevanceScore: number;
  diversityScore: number;
  matchedKeywords: string[];
  searchModes: CandidateSearchMode[];
}

export interface CandidateDiscoveryMetrics {
  queryCount: number;
  failedQueryCount: number;
  rawResultCount: number;
  excludedCount: number;
  duplicateByIdCount: number;
  nearDuplicateCount: number;
  uniqueCandidateCount: number;
  returnedCount: number;
  duplicateRate: number;
  categoryCount: number;
  typeGroupCount: number;
  maxCategoryShare: number;
  maxTypeGroupShare: number;
  averagePairwiseSimilarity: number;
}

export interface CandidateDiscoveryResult {
  candidates: RankedCandidate[];
  appliedExclusions: string[];
  metrics: CandidateDiscoveryMetrics;
  source: DataActualSource;
}

interface CandidateQueryResult {
  page: PlaceSearchPage;
  keyword: string;
  mode: CandidateSearchMode;
}

interface MergedCandidate {
  poi: ProviderPoi;
  matchedKeywords: Set<string>;
  searchModes: Set<CandidateSearchMode>;
}

interface MergeMetrics {
  excludedCount: number;
  duplicateByIdCount: number;
  nearDuplicateCount: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rad(value: number): number {
  return value * Math.PI / 180;
}

function distanceMeters(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const earthRadius = 6_371_000;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

function normalizeName(value: string): string {
  return value.toLowerCase()
    .replace(/[\s·•・\-—_（）()【】[\]，,。.]/g, "")
    .replace(/旗舰店|总店|分店|店$/g, "");
}

function typeGroup(poi: ProviderPoi): string {
  const typecode = poi.typecode ?? poi.tags.find((tag) => /^\d{4,}$/.test(tag));
  return typecode ? typecode.slice(0, 4) : poi.category;
}

function looksLikeSamePlace(a: ProviderPoi, b: ProviderPoi): boolean {
  const aName = normalizeName(a.name);
  const bName = normalizeName(b.name);
  if (!aName || !bName || aName !== bName) return false;
  return distanceMeters(a, b) <= 200;
}

function mergeCandidate(target: MergedCandidate, item: CandidateInput): void {
  target.matchedKeywords.add(item.keyword);
  target.searchModes.add(item.mode);
  if (target.poi.rating === null && item.poi.rating !== null) target.poi = item.poi;
}

export function mergeCandidateInputs(
  inputs: CandidateInput[],
  excludePoiIds: string[] = [],
): { candidates: MergedCandidate[]; metrics: MergeMetrics } {
  const excluded = new Set(excludePoiIds);
  const byId = new Map<string, MergedCandidate>();
  const merged: MergedCandidate[] = [];
  let excludedCount = 0;
  let duplicateByIdCount = 0;
  let nearDuplicateCount = 0;

  for (const input of inputs) {
    if (excluded.has(input.poi.id)) {
      excludedCount++;
      continue;
    }
    const existingById = byId.get(input.poi.id);
    if (existingById) {
      duplicateByIdCount++;
      mergeCandidate(existingById, input);
      continue;
    }
    const nearDuplicate = merged.find((candidate) => looksLikeSamePlace(candidate.poi, input.poi));
    if (nearDuplicate) {
      nearDuplicateCount++;
      mergeCandidate(nearDuplicate, input);
      continue;
    }
    const candidate: MergedCandidate = {
      poi: input.poi,
      matchedKeywords: new Set([input.keyword]),
      searchModes: new Set([input.mode]),
    };
    byId.set(input.poi.id, candidate);
    merged.push(candidate);
  }
  return {
    candidates: merged,
    metrics: { excludedCount, duplicateByIdCount, nearDuplicateCount },
  };
}

function keywordMatchScore(candidate: MergedCandidate): number {
  const searchable = `${candidate.poi.name} ${candidate.poi.tags.join(" ")} ${candidate.poi.description}`.toLowerCase();
  const matched = [...candidate.matchedKeywords].filter((keyword) => searchable.includes(keyword.toLowerCase())).length;
  return candidate.matchedKeywords.size === 0 ? 0 : matched / candidate.matchedKeywords.size;
}

function relevanceScore(
  candidate: MergedCandidate,
  input: CandidateDiscoveryInput,
  totalKeywords: number,
): number {
  const poi = candidate.poi;
  const rating = poi.rating === null ? 0.5 : clamp((poi.rating - 3) / 2, 0, 1);
  const distance = clamp(1 - distanceMeters(input.center, poi) / (input.radiusMeters ?? 10_000), 0, 1);
  const coverage = clamp(candidate.matchedKeywords.size / Math.max(1, totalKeywords), 0, 1);
  const keyword = keywordMatchScore(candidate);
  const completeness = [
    poi.rating !== null,
    poi.pricePerPerson !== null,
    poi.openingHours !== null,
  ].filter(Boolean).length / 3;
  return Number((
    0.30 * keyword +
    0.25 * coverage +
    0.20 * distance +
    0.15 * rating +
    0.10 * completeness
  ).toFixed(4));
}

function tokenSet(poi: ProviderPoi): Set<string> {
  return new Set([
    poi.category,
    typeGroup(poi),
    ...poi.tags.map((tag) => tag.toLowerCase()),
  ]);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = [...a].filter((value) => b.has(value)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function similarity(a: ProviderPoi, b: ProviderPoi): number {
  const semantic = jaccard(tokenSet(a), tokenSet(b));
  const spatial = clamp(1 - distanceMeters(a, b) / 2_000, 0, 1);
  const sameType = typeGroup(a) === typeGroup(b) ? 1 : 0;
  return clamp(0.45 * semantic + 0.30 * spatial + 0.25 * sameType, 0, 1);
}

export function rankCandidatePool(
  candidates: MergedCandidate[],
  input: CandidateDiscoveryInput,
): RankedCandidate[] {
  const target = clamp(Math.floor(input.candidateCount ?? 12), 1, 20);
  const diversityWeight = clamp(input.diversityWeight ?? 0.7, 0, 1);
  const scored = candidates.map((candidate) => ({
    candidate,
    relevance: relevanceScore(candidate, input, input.keywords.length),
  }));
  const selected: Array<{ candidate: MergedCandidate; relevance: number; diversityScore: number }> = [];
  const remaining = [...scored];
  const maxPerCategory = Math.max(3, Math.ceil(target * 0.6));
  const maxPerTypeGroup = Math.max(2, Math.ceil(target * 0.3));

  while (selected.length < target && remaining.length > 0) {
    const categoryCounts = new Map<string, number>();
    const typeCounts = new Map<string, number>();
    for (const item of selected) {
      categoryCounts.set(item.candidate.poi.category, (categoryCounts.get(item.candidate.poi.category) ?? 0) + 1);
      const group = typeGroup(item.candidate.poi);
      typeCounts.set(group, (typeCounts.get(group) ?? 0) + 1);
    }
    const withinCaps = (item: typeof remaining[number]) =>
      (categoryCounts.get(item.candidate.poi.category) ?? 0) < maxPerCategory &&
      (typeCounts.get(typeGroup(item.candidate.poi)) ?? 0) < maxPerTypeGroup;
    const hasCandidateWithinCaps = remaining.some(withinCaps);
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index++) {
      const current = remaining[index]!;
      if (hasCandidateWithinCaps && !withinCaps(current)) continue;
      const maxSimilarity = selected.length === 0
        ? 0
        : Math.max(...selected.map((item) => similarity(current.candidate.poi, item.candidate.poi)));
      const diversityScore = current.relevance - diversityWeight * 0.45 * maxSimilarity;
      if (diversityScore > bestScore) {
        bestScore = diversityScore;
        bestIndex = index;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (!chosen) break;
    const maxSimilarity = selected.length === 0
      ? 0
      : Math.max(...selected.map((item) => similarity(chosen.candidate.poi, item.candidate.poi)));
    selected.push({
      ...chosen,
      diversityScore: Number((chosen.relevance - diversityWeight * 0.45 * maxSimilarity).toFixed(4)),
    });
  }

  return selected.map((item, index) => ({
    poi: item.candidate.poi,
    rank: index + 1,
    relevanceScore: item.relevance,
    diversityScore: item.diversityScore,
    matchedKeywords: [...item.candidate.matchedKeywords],
    searchModes: [...item.candidate.searchModes],
  }));
}

function maxShare(values: string[]): number {
  if (values.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Number((Math.max(...counts.values()) / values.length).toFixed(4));
}

function averagePairwiseSimilarity(candidates: RankedCandidate[]): number {
  if (candidates.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let left = 0; left < candidates.length; left++) {
    for (let right = left + 1; right < candidates.length; right++) {
      total += similarity(candidates[left]!.poi, candidates[right]!.poi);
      pairs++;
    }
  }
  return pairs === 0 ? 0 : Number((total / pairs).toFixed(4));
}

function filterCategory(pois: ProviderPoi[], category: CandidateCategory): ProviderPoi[] {
  if (category === "dining") return pois.filter((poi) => poi.category === "dining");
  if (category === "activity") return pois.filter((poi) => poi.category !== "dining");
  return pois;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runThrottledQueries(
  tasks: Array<() => Promise<CandidateQueryResult>>,
  batchSize = 2,
  batchDelayMs = 550,
): Promise<Array<PromiseSettledResult<CandidateQueryResult>>> {
  const results: Array<PromiseSettledResult<CandidateQueryResult>> = [];
  for (let index = 0; index < tasks.length; index += batchSize) {
    const batch = tasks.slice(index, index + batchSize).map((task) => task());
    results.push(...await Promise.allSettled(batch));
    if (index + batchSize < tasks.length) await wait(batchDelayMs);
  }
  return results;
}

export class CandidateDiscoveryService {
  async discover(provider: DataProvider, input: CandidateDiscoveryInput): Promise<CandidateDiscoveryResult> {
    const keywords = [...new Set(input.keywords.map((keyword) => keyword.trim()).filter(Boolean))].slice(0, 4);
    if (keywords.length === 0) throw new Error("At least one keyword is required");
    const modes = [...new Set(input.modes ?? ["text", "nearby"])];
    const pageSize = 25;
    const queries: Array<() => Promise<CandidateQueryResult>> = [];

    for (const keyword of keywords) {
      if (modes.includes("text")) {
        queries.push(() => provider.searchPlacesText({
          keywords: [keyword],
          city: input.city,
          types: input.types,
          page: 1,
          pageSize,
          excludePoiIds: input.excludePoiIds,
        }).then((page) => ({ page, keyword, mode: "text" })));
      }
      if (modes.includes("nearby")) {
        queries.push(() => provider.searchPlacesNearby({
          location: input.center,
          keywords: [keyword],
          types: input.types,
          radiusMeters: input.radiusMeters ?? 10_000,
          page: 1,
          pageSize,
          excludePoiIds: input.excludePoiIds,
        }).then((page) => ({ page, keyword, mode: "nearby" })));
      }
    }

    // 高德免费/低配额 key 对瞬时 QPS 很敏感。每批 2 个、批间 550ms，
    // 在保留有限并发的同时避免 4-8 个请求同一时刻打爆 CUQPS。
    const settled = await runThrottledQueries(queries);
    const successful = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (successful.length === 0) {
      const firstFailure = settled.find((result) => result.status === "rejected");
      throw firstFailure && firstFailure.status === "rejected"
        ? firstFailure.reason
        : new Error("All candidate discovery queries failed");
    }
    const category = input.category ?? "mixed";
    const rawInputs = successful.flatMap(({ page, keyword, mode }) =>
      filterCategory(page.pois, category).map((poi) => ({ poi, keyword, mode })));
    const merged = mergeCandidateInputs(rawInputs, input.excludePoiIds);
    const normalizedInput = { ...input, keywords };
    const ranked = rankCandidatePool(merged.candidates, normalizedInput);
    const rawResultCount = rawInputs.length + merged.metrics.excludedCount;
    const duplicateCount = merged.metrics.duplicateByIdCount + merged.metrics.nearDuplicateCount;
    const sources = new Set(successful.map(({ page }) => page.source));
    const actualSource: DataActualSource = sources.size > 1 ? "mixed" : [...sources][0] ?? provider.kind;

    return {
      candidates: ranked,
      appliedExclusions: [...new Set(input.excludePoiIds ?? [])],
      source: actualSource,
      metrics: {
        queryCount: queries.length,
        failedQueryCount: settled.length - successful.length,
        rawResultCount,
        excludedCount: merged.metrics.excludedCount,
        duplicateByIdCount: merged.metrics.duplicateByIdCount,
        nearDuplicateCount: merged.metrics.nearDuplicateCount,
        uniqueCandidateCount: merged.candidates.length,
        returnedCount: ranked.length,
        duplicateRate: rawResultCount === 0 ? 0 : Number((duplicateCount / rawResultCount).toFixed(4)),
        categoryCount: new Set(ranked.map((candidate) => candidate.poi.category)).size,
        typeGroupCount: new Set(ranked.map((candidate) => typeGroup(candidate.poi))).size,
        maxCategoryShare: maxShare(ranked.map((candidate) => candidate.poi.category)),
        maxTypeGroupShare: maxShare(ranked.map((candidate) => typeGroup(candidate.poi))),
        averagePairwiseSimilarity: averagePairwiseSimilarity(ranked),
      },
    };
  }
}
