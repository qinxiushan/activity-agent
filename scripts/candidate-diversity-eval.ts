import fs from "node:fs";
import path from "node:path";
import { AmapDataProvider } from "../lib/amap-data-provider";
import { MockDataProvider } from "../lib/mock-data-provider";
import { CandidateDiscoveryService } from "../lib/candidate-discovery";

function loadKey(): string {
  if (process.env.AMAP_MAPS_API_KEY) return process.env.AMAP_MAPS_API_KEY;
  const env = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  const match = env.match(/^AMAP_MAPS_API_KEY\s*=\s*(.+)$/m);
  if (!match) throw new Error("AMAP_MAPS_API_KEY 未设置");
  return match[1]!.trim().replace(/^["']|["']$/g, "");
}

async function main(): Promise<void> {
  const city = process.env.CANDIDATE_EVAL_CITY ?? "广州";
  const departure = process.env.CANDIDATE_EVAL_DEPARTURE ?? "广州塔";
  const keywords = (process.env.CANDIDATE_EVAL_KEYWORDS ?? "当代艺术,摄影展,历史建筑")
    .split(",").map((value) => value.trim()).filter(Boolean).slice(0, 4);
  const provider = new AmapDataProvider(loadKey(), new MockDataProvider());
  const service = new CandidateDiscoveryService();
  const center = await provider.geocode(departure, city);
  const common = {
    city,
    center: { lng: center.lng, lat: center.lat },
    keywords,
    category: "activity" as const,
    radiusMeters: 15_000,
    candidateCount: 10,
    diversityWeight: 0.75,
  };

  const first = await service.discover(provider, common);
  const firstSelectedIds = first.candidates.slice(0, 5).map((candidate) => candidate.poi.id);
  const second = await service.discover(provider, { ...common, excludePoiIds: firstSelectedIds });
  const secondIds = new Set(second.candidates.map((candidate) => candidate.poi.id));
  const overlap = firstSelectedIds.filter((id) => secondIds.has(id));
  const uniqueFirst = new Set(first.candidates.map((candidate) => candidate.poi.id)).size;
  const uniqueSecond = new Set(second.candidates.map((candidate) => candidate.poi.id)).size;

  const report = {
    city,
    departure: center.name,
    keywords,
    first: {
      metrics: first.metrics,
      uniqueIds: uniqueFirst,
      top: first.candidates.map((candidate) => ({
        rank: candidate.rank,
        name: candidate.poi.name,
        category: candidate.poi.category,
        typecode: candidate.poi.typecode,
        relevanceScore: candidate.relevanceScore,
        diversityScore: candidate.diversityScore,
      })),
    },
    regeneration: {
      excludedCount: firstSelectedIds.length,
      metrics: second.metrics,
      uniqueIds: uniqueSecond,
      overlapWithExcluded: overlap,
      overlapRate: firstSelectedIds.length === 0 ? 0 : overlap.length / firstSelectedIds.length,
    },
  };
  console.log(JSON.stringify(report, null, 2));

  const passed = first.candidates.length >= 5 &&
    uniqueFirst === first.candidates.length &&
    uniqueSecond === second.candidates.length &&
    overlap.length === 0 &&
    first.metrics.maxTypeGroupShare <= 0.4 &&
    first.metrics.maxCategoryShare <= 0.7;
  if (!passed) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
