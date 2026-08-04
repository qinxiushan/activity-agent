/**
 * Reducer 单测（route-B 改动 1）——纯函数、无 I/O、快。
 * 跑法：npx tsx scripts/reducer-test.ts
 */

import { reduce, hashOf, type PlanEvent } from "../lib/plan-reducer";
import type { PlanPhase, PlanState, ProposedPlan } from "../lib/plan-state";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { pass++; } else { fail++; console.error(`❌ ${msg}`); }
}

const samplePlan: ProposedPlan = {
  summary: "上海一日游",
  timeline: [{ startTime: "14:00", endTime: "16:00", type: "activity", poiId: "poi-1" }],
  totalCost: 300,
  totalDurationMinutes: 120,
  weather: { city: "上海", date: "2026-07-25", condition: "晴", tempMax: 30, tempMin: 22, advice: "" },
};

function mkState(phase: PlanPhase, plan: ProposedPlan | null = null): PlanState {
  return {
    sessionId: "t", phase, turnCount: 0, clarificationCount: 0,
    intent: {}, plan, lastTransitionAt: 0, history: [],
  };
}

const H = hashOf(samplePlan);

// ── hashOf 性质 ─────────────────────────────────────────────
assert(hashOf(samplePlan) === hashOf(samplePlan), "hashOf 确定性：同方案同 hash");
assert(hashOf(samplePlan) !== hashOf({ ...samplePlan, totalCost: 999 }), "hashOf 敏感性：金额变则 hash 变");
assert(hashOf({ ...samplePlan, summary: "改个文案" }) === H, "hashOf 只认关键字段：改文案不变 hash");
assert(hashOf(null) === "", "hashOf(null) === ''");

// ── USER_TURN_CLASSIFIED ────────────────────────────────────
const question: PlanEvent = { type: "USER_TURN_CLASSIFIED", intent: "question" };
assert(reduce(mkState("plan_confirm", samplePlan), question).phase === "plan_confirm",
  "★回归：plan_confirm 提问 → 相位不变（不炸方案）");

const cancelInClarify: PlanEvent = { type: "USER_TURN_CLASSIFIED", intent: "cancel" };
assert(reduce(mkState("clarifying"), cancelInClarify).phase === "cancelled",
  "★回归：clarifying 取消 → cancelled（可取消）");

assert(reduce(mkState("clarifying"), { type: "USER_TURN_CLASSIFIED", intent: "answer" }).phase === "intent_capture",
  "clarifying 回答 → intent_capture（回去重判）");

assert(reduce(mkState("idle"), { type: "USER_TURN_CLASSIFIED", intent: "new_request" }).phase === "intent_capture",
  "idle 新请求 → intent_capture");
assert(reduce(mkState("idle"), { type: "USER_TURN_CLASSIFIED", intent: "smalltalk" }).phase === "idle",
  "idle 问候/闲聊 → 保持 idle");

const confirmOk: PlanEvent = { type: "USER_TURN_CLASSIFIED", intent: "confirm", planHash: H };
assert(reduce(mkState("plan_confirm", samplePlan), confirmOk).phase === "executing",
  "plan_confirm 确认(hash 对) → executing");

const confirmStale: PlanEvent = { type: "USER_TURN_CLASSIFIED", intent: "confirm", planHash: "deadbeef" };
const staleOut = reduce(mkState("plan_confirm", samplePlan), confirmStale);
assert(staleOut.phase === "plan_confirm" && staleOut.effects.includes("warn_stale"),
  "★plan_confirm 确认(hash 不符) → 不变 + warn_stale");

assert(reduce(mkState("plan_confirm", samplePlan), { type: "USER_TURN_CLASSIFIED", intent: "modify" }).phase === "planning",
  "plan_confirm 修改 → planning");

// ── 进度事件 ────────────────────────────────────────────────
assert(reduce(mkState("intent_capture"), { type: "INTENT_FIELDS_UPDATED", missingCount: 0 }).phase === "planning",
  "intent_capture 字段齐 → planning");
assert(reduce(mkState("intent_capture"), { type: "INTENT_FIELDS_UPDATED", missingCount: 2 }).phase === "intent_capture",
  "intent_capture 字段缺 → 不变");
assert(reduce(mkState("intent_capture"), { type: "CLARIFICATION_ASKED" }).phase === "clarifying",
  "追问 → clarifying");

const submit = reduce(mkState("planning"), { type: "PLAN_SUBMITTED", plan: samplePlan });
assert(submit.phase === "plan_confirm" && submit.plan === samplePlan, "planning 提交方案 → plan_confirm + 带 plan");
assert(reduce(mkState("intent_capture"), { type: "PLAN_SUBMITTED", plan: samplePlan }).effects.includes("reject_out_of_phase"),
  "非 planning 提交方案 → reject_out_of_phase");

// ── 结构化确认（按钮） ──────────────────────────────────────
assert(reduce(mkState("plan_confirm", samplePlan), { type: "USER_CONFIRMED", planHash: H }).phase === "executing",
  "USER_CONFIRMED(hash 对) → executing");
const btnStale = reduce(mkState("plan_confirm", samplePlan), { type: "USER_CONFIRMED", planHash: "x" });
assert(btnStale.phase === "plan_confirm" && btnStale.effects.includes("reject"),
  "USER_CONFIRMED(hash 不符) → 不变 + reject");

// ── 预订回调 ────────────────────────────────────────────────
assert(reduce(mkState("executing"), { type: "BOOKING_RESULT", ok: true }).phase === "completed",
  "executing 预订成功 → completed");
assert(reduce(mkState("executing"), { type: "BOOKING_RESULT", ok: false }).phase === "plan_confirm",
  "executing 预订失败 → plan_confirm");

// ── 取消/超时 ───────────────────────────────────────────────
assert(reduce(mkState("planning"), { type: "CANCEL" }).phase === "cancelled", "CANCEL → cancelled");

console.log(`\nreducer-test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
