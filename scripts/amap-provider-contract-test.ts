import { AmapDataProvider } from "../lib/amap-data-provider";
import { assessDataQuality } from "../lib/data-quality";
import { MockDataProvider } from "../lib/mock-data-provider";
import { RoutePlanningService } from "../lib/route-planning-service";
import { AmapRequestScheduler } from "../lib/amap-request-scheduler";

let pass = 0;
let fail = 0;
let forceCuqpsAttempts = 0;
function assert(label: string, condition: boolean): void {
  if (condition) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}`);
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const path = url.pathname;
  if (url.searchParams.get("key") === "force-error") {
    return Promise.resolve(json({ status: "0", info: "INVALID_USER_KEY" }));
  }
  if (url.searchParams.get("key") === "force-cuqps" && path.endsWith("/geocode/geo")) {
    forceCuqpsAttempts++;
    if (forceCuqpsAttempts === 1) {
      return Promise.resolve(json({ status: "0", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT" }));
    }
  }
  if (path.endsWith("/geocode/geo")) {
    return Promise.resolve(json({
      status: "1",
      geocodes: [{ location: "116.397428,39.90923", formatted_address: "北京市东城区天安门", city: "北京", district: "东城区" }],
    }));
  }
  if (path.endsWith("/weather/weatherInfo")) {
    return Promise.resolve(json({
      status: "1",
      forecasts: [{ casts: [{ date: "2026-08-01", dayweather: "雷阵雨", nightweather: "多云", daytemp: "31", nighttemp: "24" }] }],
    }));
  }
  if (path.endsWith("/place/text")) {
    return Promise.resolve(json({
      status: "1",
      count: "1",
      pois: [{
        id: "AMAP-001", name: "测试博物馆", cityname: "北京", adname: "东城区",
        location: "116.401,39.910", type: "科教文化服务;博物馆", typecode: "140100",
        address: "测试路1号", biz_ext: { rating: "4.8", cost: [], open_time: [] },
      }],
    }));
  }
  if (path.endsWith("/place/detail")) {
    return Promise.resolve(json({
      status: "1",
      pois: [{
        id: "AMAP-001", name: "测试博物馆", cityname: "北京", adname: "东城区",
        location: "116.401,39.910", type: "科教文化服务;博物馆", typecode: "140100",
        address: "测试路1号", biz_ext: { rating: "4.8", cost: [], open_time: [] },
      }],
    }));
  }
  if (path.endsWith("/direction/walking")) {
    return Promise.resolve(json({ status: "1", route: { paths: [{ distance: "1200", duration: "900" }] } }));
  }
  if (path.endsWith("/direction/driving")) {
    return Promise.resolve(json({ status: "1", route: { paths: [{ distance: "1800", duration: "420", tolls: "0" }] } }));
  }
  if (path.endsWith("/direction/transit/integrated")) {
    return Promise.resolve(json({ status: "1", route: { transits: [{ distance: "1600", duration: "720", cost: "4" }] } }));
  }
  if (path.endsWith("/direction/bicycling")) {
    return Promise.resolve(json({ errcode: 0, data: { paths: [{ distance: 1300, duration: 360 }] } }));
  }
  if (path.endsWith("/distance")) {
    return Promise.resolve(json({ status: "1", results: [{ origin_id: "1", distance: "1800", duration: "420" }] }));
  }
  return Promise.resolve(json({ status: "0", info: `UNHANDLED ${path}` }));
}

async function main(): Promise<void> {
  const reservationClock = { now: () => 0, sleep: async (_ms: number) => {} };
  const sameServiceScheduler = new AmapRequestScheduler({ qps: 3, clock: reservationClock });
  const sameService = await Promise.all([0, 1, 2, 3].map(() =>
    sameServiceScheduler.schedule("v3:distance", async () => true)));
  const reservedWaits = sameService.map((item) => item.queueWaitMs);
  assert("Same-service admissions never exceed configured 3 QPS", reservedWaits.join(",") === "0,334,668,1002");

  const crossServiceScheduler = new AmapRequestScheduler({ qps: 3, clock: reservationClock });
  const crossService = await Promise.all(["v3:direction/walking", "v3:direction/driving"].map((service) =>
    crossServiceScheduler.schedule(service, async () => true)));
  assert("Different AMap services remain concurrently admissible", crossService.every((item) => item.queueWaitMs === 0));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch as typeof fetch;
  try {
    const provider = new AmapDataProvider("contract-key", new MockDataProvider());
    const geocode = await provider.geocode("天安门", "北京");
    assert("Geocode returns GCJ-02 coordinates", geocode.coordinateSystem === "GCJ-02");
    assert("Geocode keeps AMap provenance", geocode.source === "amap");

    const weather = await provider.getWeather("北京", "2026-08-01");
    assert("Chinese weather maps to stable rainy enum", weather.condition === "rainy");
    assert("Unavailable precipitation stays null", weather.precipitation === null);
    assert("Unavailable wind speed stays null", weather.windSpeed === null);
    const weatherQuality = assessDataQuality("weather", weather, "amap");
    assert("Weather quality lists both missing facts", weatherQuality.missingFields.length === 2);
    assert("Incomplete AMap weather has medium confidence", weatherQuality.confidence === "medium");

    const search = await provider.searchPlacesText({ city: "北京", keywords: ["博物馆"], pageSize: 10 });
    assert("Text search returns AMap page source", search.source === "amap");
    assert("Activity price is not inferred from AMap biz cost", search.pois[0]?.pricePerPerson === null);
    assert("POI rating is parsed as a number", search.pois[0]?.rating === 4.8);

    const from = { id: "from", name: "起点", city: "北京", lng: 116.397428, lat: 39.90923 };
    const to = { id: "to", name: "终点", city: "北京", lng: 116.401, lat: 39.91 };
    const comparison = await new RoutePlanningService(provider).compare(from, to);
    assert("All four route modes remain distinct", comparison.options.map((item) => item.mode).join(",") === "walking,transit,driving,bicycling");
    assert("All contract routes are available", comparison.options.every((item) => item.available));
    assert("All available routes disclose AMap source",
      comparison.options.every((item) => !item.available || item.source === "amap"));

    const matrix = await provider.computeDistanceMatrix([from, to], "driving");
    assert("Two-point matrix returns both directed legs", matrix.length === 2);
    assert("Matrix duration is converted to minutes", matrix.every((entry) => entry.durationMinutes === 7));

    let rejectedInvalidKey = false;
    try {
      await new AmapDataProvider("force-error", new MockDataProvider()).geocode("天安门", "北京");
    } catch {
      rejectedInvalidKey = true;
    }
    assert("Provider rejects upstream API errors", rejectedInvalidKey);

    forceCuqpsAttempts = 0;
    const retryScheduler = new AmapRequestScheduler({ qps: 3, clock: reservationClock });
    const recovered = await new AmapDataProvider("force-cuqps", new MockDataProvider(), retryScheduler)
      .geocode("天安门", "北京");
    assert("CUQPS retries only the failed provider request once", forceCuqpsAttempts === 2);
    assert("CUQPS targeted retry recovers live provider result", recovered.source === "amap");
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log(`\nProvider contract: ${pass} pass, ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 2;
});
