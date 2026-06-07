/**
 * P0 + SOP-v2 Smoke Test - 验证完整工作流
 *
 * 覆盖：
 * - P0-1: POI 数据库（含 openingHours）
 * - P0-2: 预订服务（状态机）
 * - P0-3: 8-阶段状态机（单次确认 + 1-次追问）
 * - P0-4: 工具包装（重试 + 降级）
 * - 新服务: weather / route / opening-hours
 * - 集成: 12 工具 + 包装 + 守卫
 *
 * 跑法：npx tsx scripts/p0-smoke-test.ts
 */

import { searchPOIs, getDatabaseStats, getSupportedCities, getPOIById } from "../lib/poi-database";
import { BookingService, BookingError } from "../lib/booking-service";
import {
  PlanStateManager,
  classifyUserConfirmation,
  isToolAllowedInPhase,
  describeWaitingFor,
  setActivePlanState,
  getActivePlanState,
  guardToolCallWithActive,
  getMissingCriticalFields,
  MAX_CLARIFICATIONS,
} from "../lib/plan-state";
import { wrapToolWithResilience, getRecentMetrics, clearMetrics, recordToolMetric } from "../lib/tool-wrapper";
import { getWeather } from "../lib/weather-service";
import { computeRoute, buildRouteChain, haversineMeters } from "../lib/route-service";
import { isOpenAt, parseHoursString } from "../lib/opening-hours-service";
import { UserPreferencesStore, DEFAULT_USER_ID, type UserPreferencesDefaults } from "../lib/user-preferences";
import { promises as afs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

let pass = 0;
let fail = 0;
const log = (label: string, ok: boolean, detail?: string) => {
  if (ok) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`); }
  else    { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); process.exitCode = 1; }
};
const section = (name: string) => console.log(`\n${name}`);

async function main() {
  console.log("\n=== SOP-v2 Smoke Test ===\n");

  // ─── P0-1: POI Database（含 openingHours）────────────────────
  section("📍 P0-1: POI Database");
  const stats = getDatabaseStats();
  log("Has 3 cities", stats.cities.length === 3, stats.cities.join(", "));
  log("Total POIs >= 30", stats.total >= 30, `${stats.total} POIs`);

  const yhy = getPOIById("bj-001");
  log("颐和园 has openingHours", !!yhy?.openingHours, yhy?.openingHours);

  const gg = getPOIById("bj-005");
  log("故宫 has 7-day openingHours (周一闭馆)", !!gg?.openingHours && gg.openingHours.includes(","), gg?.openingHours);

  const bjCultural = searchPOIs({ city: "北京", category: "cultural", limit: 3, radiusMeters: 50_000 });
  log("Beijing cultural search returns 3", bjCultural.length === 3);

  const filtered = searchPOIs({ city: "北京", category: "dining", budget: { min: 0, max: 200 }, limit: 5 });
  log("Beijing dining under 200¥", filtered.every((r) => r.poi.pricePerPerson <= 200));

  const shChinese = searchPOIs({ city: "上海", category: "dining", cuisine: "chinese", limit: 3 });
  log("Shanghai chinese cuisine", shChinese.length > 0);

  // ─── 新服务：天气 ─────────────────────────────────────
  section("Weather Service");
  const w = getWeather("北京", "2026-07-15");
  log("Has condition + description", !!w.condition && !!w.description, `${w.condition} ${w.description}`);
  log("Has temp range", w.tempMax > w.tempMin, `${w.tempMin}–${w.tempMax}°C`);
  log("Has advice string", w.advice.length > 0, w.advice);
  log("Has suitableForOutdoor", typeof w.suitableForOutdoor === "boolean");

  // ─── 新服务：通勤 ─────────────────────────────────────
  section("Route Service");
  const from = { id: "departure", name: "三里屯", lng: 116.453, lat: 39.937 };
  const to = { id: "798", name: "798", lng: 116.497, lat: 39.984 };
  const r = computeRoute(from, to);
  log("Haversine distance plausible (>0)", r.distanceMeters > 0, `${r.distanceMeters}m`);
  log("Duration plausible (>0)", r.durationMinutes > 0, `${r.durationMinutes}min`);

  const shortA = { id: "a", name: "三里屯 A", lng: 116.4530, lat: 39.9370 };
  const shortB = { id: "b", name: "三里屯 B", lng: 116.4540, lat: 39.9380 };
  const shortR = computeRoute(shortA, shortB);
  log("Walking mode for short distance (<1.5km)", shortR.mode === "walking", shortR.mode);

  const long = computeRoute({ id: "a", name: "颐和园", lng: 116.275, lat: 39.999 }, { id: "b", name: "环球影城", lng: 116.685, lat: 39.781 });
  log("Long distance picks driving", long.mode === "driving", long.mode);

  const chain = buildRouteChain([
    { id: "1", name: "三里屯", lng: 116.453, lat: 39.937 },
    { id: "2", name: "798", lng: 116.497, lat: 39.984 },
    { id: "3", name: "朝阳公园", lng: 116.479, lat: 39.939 },
  ]);
  log("Chain has 2 legs", chain.legs.length === 2);
  log("Chain totalKm > 0", chain.totalKm > 0, `${chain.totalKm}km`);

  const direct = haversineMeters({ lng: 116.4, lat: 39.9 }, { lng: 116.5, lat: 39.9 });
  log("Haversine direct distance", direct > 8000 && direct < 12000, `${Math.round(direct)}m`);

  // ─── 新服务：营业时间 ──────────────────────────────────
  section("🕐 Opening Hours Service");
  const hoursEveryday = parseHoursString("10:00-22:00");
  log("Single segment expands to 7 days", hoursEveryday.schedule.every((s) => s !== null));
  const hoursMuseum = parseHoursString("-,09:00-17:00,09:00-17:00,09:00-17:00,09:00-17:00,09:00-17:00,09:00-17:00");
  log("Mon closed (museum pattern)", hoursMuseum.schedule[0] === null);
  log("Tue open", hoursMuseum.schedule[1] !== null);

  // 营业中测试（周三 10:00）
  const wed10 = isOpenAt(hoursMuseum, new Date("2026-06-10T10:00:00"));
  log("Wed 10:00 open", wed10.open === true);

  // 周一 10:00 闭馆
  const mon10 = isOpenAt(hoursMuseum, new Date("2026-06-08T10:00:00"));
  log("Mon 10:00 closed", mon10.open === false);

  // ─── P0-2: Booking Service ──────────────────────────────
  section("📅 P0-2: Booking Service");
  const svc = new BookingService({ processingDelayMs: 50, failureRate: 0 });
  const order = await svc.createBooking({
    restaurantId: "bj-r-002",
    restaurantName: "海底捞",
    date: "2026-12-25",
    time: "18:30",
    partySize: 4,
    userId: "smoke-test",
  });
  log("Order created with ORD- prefix", order.orderId.startsWith("ORD-"), order.orderId);
  log("Initial status pending/processing", ["pending", "processing"].includes(order.status));

  await new Promise((r) => setTimeout(r, 200));
  const fetched = await svc.getOrder(order.orderId);
  log("Reached confirmed/notified", fetched?.status === "confirmed" || fetched?.status === "notified", fetched?.status);
  log("Has confirmation code", !!fetched?.confirmationCode);

  try {
    await svc.createBooking({ restaurantId: "invalid-id", restaurantName: "x", date: "2026-12-25", time: "18:30", partySize: 2, userId: "smoke" });
    log("Invalid restaurant rejected", false);
  } catch (e) {
    log("Invalid restaurant rejected", e instanceof BookingError && e.code === "RESTAURANT_NOT_FOUND");
  }

  try {
    await svc.createBooking({ restaurantId: "bj-r-002", restaurantName: "x", date: "2020-01-01", time: "18:30", partySize: 2, userId: "smoke" });
    log("Past date rejected", false);
  } catch (e) {
    log("Past date rejected", e instanceof BookingError && e.code === "PAST_DATE");
  }

  // ─── P0-3: 8-阶段状态机 ──────────────────────────────
  section("🎯 P0-3: 8-phase state machine");
  const mgr = new PlanStateManager("smoke-session-v2");
  setActivePlanState(mgr);

  log("Initial phase idle", mgr.currentPhase === "idle");
  log("intent_parse allowed in intent_capture", isToolAllowedInPhase("intent_parse", "intent_capture"));
  log("intent_parse allowed in clarifying", isToolAllowedInPhase("intent_parse", "clarifying"));
  log("intent_parse allowed in planning (for plan submit)", isToolAllowedInPhase("intent_parse", "planning"));
  log("ask_clarification allowed in intent_capture", isToolAllowedInPhase("ask_clarification", "intent_capture"));
  log("ask_clarification BLOCKED in clarifying (1-次硬限)", !isToolAllowedInPhase("ask_clarification", "clarifying"));
  log("ask_clarification BLOCKED in planning", !isToolAllowedInPhase("ask_clarification", "planning"));
  log("get_weather allowed in planning", isToolAllowedInPhase("get_weather", "planning"));
  log("search_activities BLOCKED in intent_capture", !isToolAllowedInPhase("search_activities", "intent_capture"));
  log("search_activities allowed in planning", isToolAllowedInPhase("search_activities", "planning"));
  log("reservation_exec BLOCKED in plan_confirm (SOP-v2: 必须等用户确认)", !isToolAllowedInPhase("reservation_exec", "plan_confirm"));
  log("reservation_exec allowed in executing (user confirmed)", isToolAllowedInPhase("reservation_exec", "executing"));
  log("reservation_exec BLOCKED in planning", !isToolAllowedInPhase("reservation_exec", "planning"));
  log("reservation_exec BLOCKED in intent_capture", !isToolAllowedInPhase("reservation_exec", "intent_capture"));
  log("retry_booking BLOCKED in plan_confirm (SOP-v2: 必须等用户确认)", !isToolAllowedInPhase("retry_booking", "plan_confirm"));
  log("retry_booking allowed in executing", isToolAllowedInPhase("retry_booking", "executing"));

  // 完整流程：idle → intent_capture → planning → plan_confirm → executing → completed
  const t1 = await mgr.transition("intent_capture", "user input");
  log("Transition idle → intent_capture", t1.ok);
  const t2 = await mgr.transition("planning", "all critical fields present");
  log("Transition intent_capture → planning", t2.ok);
  const t3 = await mgr.transition("plan_confirm", "LLM presented plan");
  log("Transition planning → plan_confirm", t3.ok);
  const t4 = await mgr.transition("executing", "user confirmed");
  log("Transition plan_confirm → executing", t4.ok);
  const t5 = await mgr.transition("completed", "all bookings done");
  log("Transition executing → completed", t5.ok);

  // 越界检查
  const mgr2 = new PlanStateManager("smoke-illegal");
  setActivePlanState(mgr2);
  const tBad = await mgr2.transition("executing", "skipped");
  log("Illegal transition idle → executing BLOCKED", !tBad.ok);

  const tBad2 = await mgr2.transition("intent_capture", "new turn");
  await mgr2.transition("clarifying", "asked");
  const tBad3 = await mgr2.transition("executing", "skipped");
  log("Illegal transition clarifying → executing BLOCKED", !tBad3.ok);

  // 1-次追问硬限
  log("MAX_CLARIFICATIONS = 1", MAX_CLARIFICATIONS === 1);
  const mgr3 = new PlanStateManager("smoke-clarify");
  setActivePlanState(mgr3);
  await mgr3.transition("intent_capture", "start");
  const inc1 = mgr3.incrementClarification();
  log("1st clarification allowed", inc1 === true);
  const inc2 = mgr3.incrementClarification();
  log("2nd clarification BLOCKED", inc2 === false);

  // Critical fields
  const missing1 = getMissingCriticalFields({ date: "2026-07-15", startTime: "10:00" });
  log("Missing 3 critical fields when only date+time", missing1.length === 3, missing1.join(", "));
  const missing2 = getMissingCriticalFields({
    date: "2026-07-15", startTime: "10:00", partySize: 2,
    departurePoint: { name: "三里屯", city: "北京", lng: 116.453, lat: 39.937 },
    budgetPerPerson: 300,
  });
  log("All critical present → empty missing", missing2.length === 0);

  // 分类
  log("Classify '确认'", classifyUserConfirmation("确认") === "confirm");
  log("Classify '好的'", classifyUserConfirmation("好的") === "confirm");
  log("Classify '改一下'", classifyUserConfirmation("改一下") === "modify");
  log("Classify '重新生成'", classifyUserConfirmation("重新生成") === "modify");
  log("Classify '不要'", classifyUserConfirmation("不要") === "reject");
  log("Classify '我想去公园'", classifyUserConfirmation("我想去公园") === "ambiguous");

  log("Active plan state set", getActivePlanState() === mgr3);
  const guardActive = guardToolCallWithActive("reservation_exec");
  log("Guard reservation_exec in intent_capture blocked", !guardActive.allowed);

  // ─── P0-4: Tool Wrapper ─────────────────────────────────
  section("🛡️ P0-4: Tool Wrapper");
  clearMetrics();
  let callCount = 0;
  const flakyTool: ToolDefinition = {
    name: "flaky", label: "flaky", description: "flaky",
    parameters: { type: "object", properties: {} } as never,
    execute: async () => {
      callCount++;
      if (callCount < 3) throw new Error(`transient ${callCount}`);
      return { content: [{ type: "text", text: "ok" }], details: { ok: true } };
    },
  };
  const wrapped = wrapToolWithResilience(flakyTool, {
    retry: { maxRetries: 3, backoff: "fixed", baseDelay: 10, maxDelay: 50 },
    timeoutMs: 1000, onMetric: recordToolMetric,
  });
  const result = await wrapped.execute!("id", {}, undefined, undefined, {} as never);
  log("Flaky tool eventually succeeded (3 calls)", callCount === 3);
  log("Result has details.ok", (result.details as { ok: boolean })?.ok === true);

  let fallbackCalled = false;
  const alwaysFail: ToolDefinition = {
    name: "always-fail", label: "always-fail", description: "always fails",
    parameters: { type: "object", properties: {} } as never,
    execute: async () => { throw new Error("permanent"); },
  };
  const wrapped2 = wrapToolWithResilience(alwaysFail, {
    retry: { maxRetries: 1, backoff: "fixed", baseDelay: 5, maxDelay: 10 },
    timeoutMs: 500, onMetric: recordToolMetric,
    fallback: async (name) => {
      fallbackCalled = true;
      return { content: [{ type: "text", text: "fallback" }], details: { fallback: true, name } };
    },
  });
  const r2 = await wrapped2.execute!("id", {}, undefined, undefined, {} as never);
  log("Fallback invoked on permanent failure", fallbackCalled);
  log("Fallback result returned", (r2.details as { fallback: boolean })?.fallback === true);

  setActivePlanState(mgr2);
  const guardableTool: ToolDefinition = {
    name: "reservation_exec", label: "reservation_exec", description: "test",
    parameters: { type: "object", properties: {} } as never,
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { ok: true } }),
  };
  const guarded = wrapToolWithResilience(guardableTool, {
    retry: { maxRetries: 0 },
    beforeExecute: guardToolCallWithActive,
  });
  const r3 = await guarded.execute!("id", {}, undefined, undefined, {} as never);
  log("Phase guard blocks tool call (PHASE_GUARD code)", (r3.details as { error?: boolean; code?: string })?.code === "PHASE_GUARD");

  const metrics = getRecentMetrics(10);
  log("Metrics buffer has entries (>=2; guard-blocked emits none)", metrics.length >= 2, `${metrics.length} entries`);

  // ─── 集成：12 工具 + 包装 + 守卫 ────────────────────────
  section("🔌 Integration: 12 tools registered");
  const { getActivityPlannerTools, TOOL_METADATA } = await import("../src/tools/activity-tools");
  const tools = getActivityPlannerTools();
  log("12 tools registered", tools.length === 12, `${tools.length} tools`);

  const expectedTools = [
    "intent_parse", "ask_clarification", "get_weather",
    "search_activities", "search_restaurants", "check_opening_hours", "compute_route",
    "reservation_exec", "query_booking", "retry_booking",
    "plan_save", "plan_load",
  ];
  const toolNames = tools.map((t) => t.name).sort();
  const expectedSorted = [...expectedTools].sort();
  const allPresent = expectedSorted.every((n) => toolNames.includes(n));
  log("All 12 expected tools present", allPresent, toolNames.join(", "));

  log("All tools have name + label", tools.every((t) => t.name && t.label));
  log("All tools have execute fn", tools.every((t) => typeof t.execute === "function"));

  setActivePlanState(mgr3);
  const askTool = tools.find((t) => t.name === "ask_clarification");
  log("ask_clarification found", !!askTool);
  if (askTool) {
    const mgrAsk = new PlanStateManager("smoke-ask-1");
    setActivePlanState(mgrAsk);
    await mgrAsk.transition("intent_capture", "start");
    const r4 = await askTool.execute!("id", { missingFields: ["date"], question: "What date?" }, undefined, undefined, {} as never);
    log("1st ask_clarification succeeded", (r4.details as { asked?: boolean })?.asked === true);
    const r5 = await askTool.execute!("id", { missingFields: ["time"], question: "What time?" }, undefined, undefined, {} as never);
    const blockedCode = (r5.details as { code?: string })?.code;
    log("2nd ask_clarification BLOCKED (PHASE_GUARD or MAX)", blockedCode === "PHASE_GUARD" || blockedCode === "MAX_CLARIFICATIONS_EXCEEDED", blockedCode ?? "");
  }

  // 验证 intent_parse 的 plan submit
  const ipTool = tools.find((t) => t.name === "intent_parse");
  if (ipTool) {
    const mgr4 = new PlanStateManager("smoke-submit");
    setActivePlanState(mgr4);
    await mgr4.transition("intent_capture", "start");
    await mgr4.transition("planning", "all fields ok");
    const r6 = await ipTool.execute!("id", {
      submitPlan: true,
      plan: {
        summary: "颐和园 + 鼎泰丰",
        timeline: [
          { startTime: "10:00", endTime: "13:00", type: "activity", poiId: "bj-001", poiName: "颐和园" },
          { startTime: "13:30", endTime: "14:30", type: "meal", poiId: "bj-r-003", poiName: "鼎泰丰" },
        ],
        totalCost: 180, totalDurationMinutes: 270,
        weather: { city: "北京", date: "2026-07-15", condition: "sunny", tempMax: 32, tempMin: 22, advice: "适合户外" },
      },
    }, undefined, undefined, {} as never);
    log("intent_parse with submitPlan succeeded", (r6.details as { planSubmitted?: boolean })?.planSubmitted === true);
    log("Phase transitioned to plan_confirm", mgr4.currentPhase === "plan_confirm");

    const mgr5 = new PlanStateManager("smoke-resubmit");
    setActivePlanState(mgr5);
    await mgr5.transition("intent_capture", "start");
    await mgr5.transition("planning", "fields ok");
    await mgr5.transition("plan_confirm", "first submit");
    const r7 = await ipTool.execute!("id", {
      submitPlan: true,
      plan: {
        summary: "二次提交（应被拒）",
        timeline: [{ startTime: "10:00", endTime: "12:00", type: "activity", poiName: "x" }],
        totalCost: 100, totalDurationMinutes: 120,
        weather: { city: "北京", date: "2026-07-15", condition: "sunny", tempMax: 30, tempMin: 20, advice: "" },
      },
    }, undefined, undefined, {} as never);
    const resubmitCode = (r7.details as { code?: string })?.code;
    log("intent_parse submitPlan=true BLOCKED in plan_confirm (P1: 防 LLM 二次提交覆盖执行状态)", resubmitCode === "SUBMIT_PLAN_OUT_OF_PHASE" || resubmitCode === "PHASE_GUARD", resubmitCode ?? "");

    const mgr6 = new PlanStateManager("smoke-resubmit-executing");
    setActivePlanState(mgr6);
    await mgr6.transition("intent_capture", "start");
    await mgr6.transition("planning", "fields ok");
    await mgr6.transition("plan_confirm", "first submit");
    await mgr6.transition("executing", "user confirmed");
    const r8 = await ipTool.execute!("id", {
      submitPlan: true,
      plan: {
        summary: "executing 阶段再次提交（应被拒）",
        timeline: [{ startTime: "10:00", endTime: "12:00", type: "activity", poiName: "x" }],
        totalCost: 100, totalDurationMinutes: 120,
        weather: { city: "北京", date: "2026-07-15", condition: "sunny", tempMax: 30, tempMin: 20, advice: "" },
      },
    }, undefined, undefined, {} as never);
    const resubmitExecCode = (r8.details as { code?: string })?.code;
    log("intent_parse submitPlan=true BLOCKED in executing (P1: 防 LLM 二次提交覆盖执行状态)", resubmitExecCode === "SUBMIT_PLAN_OUT_OF_PHASE" || resubmitExecCode === "PHASE_GUARD", resubmitExecCode ?? "");

    setActivePlanState(mgr4);
  }

  // 每个工具 execute 一次（验证无 crash）
  setActivePlanState(null);
  for (const t of tools) {
    try {
      const r = await t.execute!("smoke", {}, undefined, undefined, {} as never);
      log(`Tool ${t.name} executes without crash`, r !== undefined);
    } catch (e) {
      log(`Tool ${t.name} executes without crash`, false, (e as Error).message);
    }
  }

  // ─── P0-5: User Preferences Store ──────────────────────────────
  section("🧠 P0-5: User Preferences Store");
  const smokeUserId = `smoke-prefs-${Date.now()}`;
  const tmpRoot = await afs.mkdtemp(path.join(os.tmpdir(), "pi-prefs-smoke-"));
  const tmpPrefsDir = path.join(tmpRoot, "prefs");
  const tmpPlanStatesDir = path.join(tmpRoot, "plan-states");
  const store = new UserPreferencesStore(smokeUserId, tmpPrefsDir);

  const empty = await store.load();
  log("Empty: defaults = {}", Object.keys(empty.defaults).length === 0);
  log("Empty: totalSessions = 0", empty.stats.totalSessions === 0);
  log("Empty: recentSessions = []", empty.recentSessions.length === 0);
  log("Empty: averageBudget = 0", empty.stats.averageBudget === 0);

  const upd1 = await store.updateDefaults({
    partySize: 2,
    budgetPerPerson: 300,
    departurePoint: { name: "三里屯", city: "北京", lng: 116.453, lat: 39.937 },
    mood: undefined,
  } satisfies Partial<UserPreferencesDefaults>);
  log("updateDefaults: partySize=2 set", upd1.defaults.partySize === 2);
  log("updateDefaults: budget=300 set", upd1.defaults.budgetPerPerson === 300);
  log("updateDefaults: undefined stripped", upd1.defaults.mood === undefined);

  const af1 = await store.autoFillIntent({ date: "2026-08-01" });
  log("autoFill: partySize filled", af1.filled.partySize === 2);
  log("autoFill: budget filled", af1.filled.budgetPerPerson === 300);
  log("autoFill: departurePoint filled", af1.filled.departurePoint?.name === "三里屯");
  log("autoFill: date NOT overwritten (user-provided)", af1.filled.date === "2026-08-01");
  log("autoFill: autoFilledFields lists 3", af1.autoFilledFields.length === 3, af1.autoFilledFields.join(","));

  const af2 = await store.autoFillIntent({
    date: "2026-08-01", startTime: "10:00", partySize: 4,
    departurePoint: { name: "国贸", city: "北京", lng: 116.46, lat: 39.91 },
    budgetPerPerson: 500,
  });
  log("autoFill: no-op when all provided", af2.autoFilledFields.length === 0);

  const planStatesA = Array.from({ length: 7 }, (_, i) => ({
    sessionId: `sess-${i}`,
    phase: "completed" as const,
    turnCount: 3,
    clarificationCount: 0,
    intent: { date: "2026-07-15", partySize: 2, departurePoint: { name: "三里屯", city: "北京", lng: 116.453, lat: 39.937 } },
    plan: { summary: `plan ${i}`, timeline: [], totalCost: 0, totalDurationMinutes: 0, weather: { city: "北京", date: "2026-07-15", condition: "sunny" as const, tempMax: 30, tempMin: 20, advice: "" } },
    lastTransitionAt: Date.now() - i * 1000,
    history: [],
  }));
  for (const ps of planStatesA) await store.recordCompletedSession(ps);
  const after1 = await store.load();
  log("recordCompletedSession: capped at 5", after1.recentSessions.length === 5);

  await store.recordCompletedSession(planStatesA[0]!);
  const after2 = await store.load();
  log("recordCompletedSession: de-dupes by sessionId", after2.recentSessions.length === 5);
  log("De-dup: first session still present", after2.recentSessions.some((s) => s.sessionId === "sess-0"));

  await store.reset();
  const after3 = await store.load();
  log("reset: recentSessions cleared", after3.recentSessions.length === 0);
  log("reset: defaults cleared", Object.keys(after3.defaults).length === 0);

  await afs.mkdir(tmpPlanStatesDir, { recursive: true });
  const refreshEmpty = await store.refreshFromHistory(tmpPlanStatesDir);
  log("refreshFromHistory: empty dir → empty defaults", Object.keys(refreshEmpty.defaults).length === 0);
  log("refreshFromHistory: empty dir → totalSessions=0", refreshEmpty.stats.totalSessions === 0);

  for (let i = 0; i < 4; i++) {
    const ps = {
      sessionId: `hist-${i}`,
      phase: i < 3 ? "completed" as const : "executing" as const,
      turnCount: 3,
      clarificationCount: 0,
      intent: {
        date: "2026-07-15",
        partySize: 2,
        departurePoint: { name: "三里屯", city: "北京", lng: 116.453, lat: 39.937 },
        budgetPerPerson: 300,
        preferredCategories: ["cultural", "dining"],
        mood: "romantic",
      },
      plan: i < 3 ? {
        summary: `hist plan ${i}`,
        timeline: [],
        totalCost: 0, totalDurationMinutes: 0,
        weather: { city: "北京", date: "2026-07-15", condition: "sunny" as const, tempMax: 30, tempMin: 20, advice: "" },
      } : null,
      lastTransitionAt: Date.now() - (10 - i) * 1000,
      history: [],
    };
    await afs.writeFile(
      path.join(tmpPlanStatesDir, `hist-${i}.json`),
      JSON.stringify(ps),
      "utf-8",
    );
  }
  const outlier = {
    sessionId: "outlier",
    phase: "completed" as const,
    turnCount: 3,
    clarificationCount: 0,
    intent: { partySize: 6, budgetPerPerson: 800, mood: "adventurous" },
    plan: { summary: "outlier", timeline: [], totalCost: 0, totalDurationMinutes: 0, weather: { city: "上海", date: "2026-07-15", condition: "sunny" as const, tempMax: 30, tempMin: 20, advice: "" } },
    lastTransitionAt: Date.now() - 1000,
    history: [],
  };
  await afs.writeFile(path.join(tmpPlanStatesDir, "outlier.json"), JSON.stringify(outlier), "utf-8");

  const refreshPopulated = await store.refreshFromHistory(tmpPlanStatesDir);
  log("refresh: partySize=2 (4/5 ≥ 50%)", refreshPopulated.defaults.partySize === 2);
  log("refresh: budgetPerPerson=300 (4/5)", refreshPopulated.defaults.budgetPerPerson === 300);
  log("refresh: departurePoint=三里屯 (4/5)", refreshPopulated.defaults.departurePoint?.name === "三里屯");
  log("refresh: mood=romantic (4/5)", refreshPopulated.defaults.mood === "romantic");
  log("refresh: preferredCategories=cultural+dining (4/5)", refreshPopulated.defaults.preferredCategories?.length === 2);
  log("refresh: totalSessions=5", refreshPopulated.stats.totalSessions === 5);
  log("refresh: totalCompletedPlans=4 (3 from hist + 1 outlier)", refreshPopulated.stats.totalCompletedPlans === 4);
  log("refresh: averageBudget=(4*300 + 800)/5 = 400", refreshPopulated.stats.averageBudget === 400);
  log("refresh: favoriteCategories has cultural", refreshPopulated.stats.favoriteCategories.some((c: { category: string }) => c.category === "cultural"));

  const reloaded = new UserPreferencesStore(smokeUserId, tmpPrefsDir);
  const reloadedPrefs = await reloaded.load();
  log("Persistence: reloaded defaults match", reloadedPrefs.defaults.partySize === 2);
  log("Persistence: reloaded stats match", reloadedPrefs.stats.totalSessions === 5);

  log("DEFAULT_USER_ID = 'default'", DEFAULT_USER_ID === "default");

  await afs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

  // ─── 综合 ──────────────────────────────────────────────
  console.log("\n=== Summary ===");
  console.log(`  Pass: ${pass}`);
  console.log(`  Fail: ${fail}`);
  console.log(`  Cities: ${getSupportedCities().join(", ")}`);
  console.log(`  Total POIs: ${stats.total}`);
  console.log(`  Tool count: ${tools.length} (declared: ${TOOL_METADATA.toolCount})`);
  console.log(`  Exit code: ${process.exitCode ?? 0}`);
  console.log("=== Done ===\n");
}

main().catch((e) => {
  console.error("💥 Smoke test crashed:", e);
  process.exit(2);
});
