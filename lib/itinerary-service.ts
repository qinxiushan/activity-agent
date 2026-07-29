import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DataProvider } from "./data-provider";
import type { ProposedPlan } from "./plan-state";

const ITINERARIES_DIR = path.join(os.homedir(), ".pi", "agent", "itineraries");

export interface ItineraryCommit {
  id: string;
  sessionId: string;
  userId: string;
  planHash: string;
  createdAt: number;
  navigationLinks: Array<{ poiId: string; poiName: string; url: string }>;
  diningSearchLinks: Array<{ poiId: string; poiName: string; url: string }>;
  downloadUrl: string;
}

interface StoredItinerary extends ItineraryCommit { ics: string; }

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function dateTime(date: string, time: string): string {
  return `${date.replace(/-/g, "")}T${time.replace(/:/g, "")}00`;
}

function endTime(start: string, end: string): string { return end || start; }

function safeId(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "_"); }

function searchUrl(name: string, city: string): string {
  return `https://www.dianping.com/search/keyword/${encodeURIComponent(city)}/0_${encodeURIComponent(name)}`;
}

function navUrl(poi: { name: string; lng: number; lat: number }): string {
  const query = new URLSearchParams({ query: poi.name, src: "activity-agent", coordinate: "gaode", callnative: "0" });
  return `https://uri.amap.com/marker?position=${poi.lng},${poi.lat}&${query}`;
}

export class ItineraryService {
  async commit(input: { sessionId: string; userId: string; planHash: string; plan: ProposedPlan; provider: DataProvider }): Promise<ItineraryCommit> {
    const idempotencyFile = path.join(ITINERARIES_DIR, `${safeId(input.userId)}-${input.planHash}.json`);
    try {
      const existing = JSON.parse(await fs.readFile(idempotencyFile, "utf8")) as StoredItinerary;
      return this.public(existing);
    } catch { /* first commit */ }

    const pois = await Promise.all(input.plan.timeline.map(async (entry) => ({ entry, poi: entry.poiId ? await input.provider.getPoiById(entry.poiId) : undefined })));
    const navigationLinks = pois.flatMap(({ poi }) => poi ? [{ poiId: poi.id, poiName: poi.name, url: navUrl(poi) }] : []);
    const diningSearchLinks = pois.flatMap(({ poi }) => poi?.category === "dining" ? [{ poiId: poi.id, poiName: poi.name, url: searchUrl(poi.name, poi.city) }] : []);
    const id = `itn_${randomUUID()}`;
    const ics = this.buildIcs(id, input.plan, pois.map(({ entry, poi }) => ({ entry, poi })));
    const record: StoredItinerary = {
      id, sessionId: input.sessionId, userId: input.userId, planHash: input.planHash, createdAt: Date.now(),
      navigationLinks, diningSearchLinks, downloadUrl: `/api/itineraries/${id}`, ics,
    };
    await fs.mkdir(ITINERARIES_DIR, { recursive: true });
    await fs.writeFile(idempotencyFile, JSON.stringify(record, null, 2), "utf8");
    return this.public(record);
  }

  async get(id: string): Promise<StoredItinerary | null> {
    try {
      const files = await fs.readdir(ITINERARIES_DIR);
      for (const file of files.filter((name) => name.endsWith(".json"))) {
        const record = JSON.parse(await fs.readFile(path.join(ITINERARIES_DIR, file), "utf8")) as StoredItinerary;
        if (record.id === id) return record;
      }
    } catch { /* no commits yet */ }
    return null;
  }

  private public(record: StoredItinerary): ItineraryCommit {
    const { ics: _ics, ...result } = record;
    return result;
  }

  private buildIcs(id: string, plan: ProposedPlan, entries: Array<{ entry: ProposedPlan["timeline"][number]; poi?: { name: string; city: string; lng: number; lat: number } }>): string {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const events = entries.map(({ entry, poi }, index) => [
      "BEGIN:VEVENT",
      `UID:${id}-${index}@activity-agent`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Asia/Shanghai:${dateTime(plan.weather.date, entry.startTime)}`,
      `DTEND;TZID=Asia/Shanghai:${dateTime(plan.weather.date, endTime(entry.startTime, entry.endTime))}`,
      `SUMMARY:${escapeIcs(entry.poiName || poi?.name || entry.type)}`,
      `DESCRIPTION:${escapeIcs(entry.notes || plan.summary)}`,
      poi ? `LOCATION:${escapeIcs(poi.name)}` : "",
      poi ? `URL:${navUrl(poi)}` : "",
      "END:VEVENT",
    ].filter(Boolean).join("\r\n")).join("\r\n");
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Activity Agent//CN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:活动行程", "X-WR-TIMEZONE:Asia/Shanghai", events, "END:VCALENDAR", ""].join("\r\n");
  }
}

declare global { var __itineraryService: ItineraryService | undefined; }
export function getItineraryService(): ItineraryService {
  globalThis.__itineraryService ??= new ItineraryService();
  return globalThis.__itineraryService;
}

export function itineraryFilename(record: Pick<ItineraryCommit, "planHash">): string {
  return `activity-itinerary-${createHash("sha1").update(record.planHash).digest("hex").slice(0, 8)}.ics`;
}
