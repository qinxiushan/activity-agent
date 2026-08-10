import { buildPairedControlReport, measureControlRun } from "../lib/eval/paired-metrics";
import type { EvalGrade, EvalRun, EvalTraceEvent } from "../lib/eval/types";
import { reduceObserveOnly } from "../lib/plan-reducer";
import type { PlanState, ProposedPlan } from "../lib/plan-state";
import { resolveWorkflowControlVariant } from "../lib/workflow-control/config";
import { evaluateWorkflowToolCall } from "../lib/workflow-control/policy";

let passed = 0;
let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}`);
  }
}

const plan: ProposedPlan = {
  summary: "contract plan",
  timeline: [{ startTime: "10:00", endTime: "11:00", type: "activity", poiId: "p1" }],
  totalCost: 100,
  totalDurationMinutes: 60,
  weather: { city: "北京", date: "2026-08-01", condition: "晴", tempMax: 30, tempMin: 20, advice: "" },
};

function grade(hardPassed: boolean, runId: string): EvalGrade {
  return {
    scenarioId: "contract",
    runId,
    hardPassed,
    checks: [],
    failureCodes: hardPassed ? [] : ["CONTRACT_FAILURE"],
    summary: { passed: hardPassed ? 1 : 0, failed: hardPassed ? 0 : 1, hardFailed: hardPassed ? 0 : 1 },
  };
}

function run(runId: string, events: EvalTraceEvent[], durationMs: number): EvalRun {
  return {
    runId,
    scenarioId: "contract",
    scenarioVersion: "1",
    target: { provider: "fake", modelId: "same-model" },
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:00:01.000Z",
    events,
    metrics: {
      durationMs,
      toolCallCount: events.filter((event) => event.type === "tool_end").length,
      errorCount: 0,
    },
  };
}

async function main(): Promise<void> {
  console.log("\n=== Eval A/B Contract Test ===\n");
  ok("phase_gated is the default", resolveWorkflowControlVariant({}) === "phase_gated");
  ok("observe_only requires explicit non-production authorization",
    resolveWorkflowControlVariant({ NODE_ENV: "test", EVAL_CONTROL_VARIANT: "observe_only", EVAL_ALLOW_UNSAFE_BASELINE: "1" }) === "observe_only");
  let productionRejected = false;
  try {
    resolveWorkflowControlVariant({ NODE_ENV: "production", EVAL_CONTROL_VARIANT: "observe_only", EVAL_ALLOW_UNSAFE_BASELINE: "1" });
  } catch { productionRejected = true; }
  ok("observe_only is rejected in production", productionRejected);
  let missingAuthorizationRejected = false;
  try {
    resolveWorkflowControlVariant({ NODE_ENV: "test", EVAL_CONTROL_VARIANT: "observe_only" });
  } catch { missingAuthorizationRejected = true; }
  ok("observe_only is rejected without the unsafe eval flag", missingAuthorizationRejected);

  const previousVariant = process.env.EVAL_CONTROL_VARIANT;
  const previousUnsafe = process.env.EVAL_ALLOW_UNSAFE_BASELINE;
  process.env.EVAL_CONTROL_VARIANT = "observe_only";
  process.env.EVAL_ALLOW_UNSAFE_BASELINE = "1";
  const observedDecision = evaluateWorkflowToolCall("commit_itinerary", "planning");
  ok("observe_only records an illegal call without blocking it",
    observedDecision.allowed && observedDecision.wouldBlock);
  if (previousVariant === undefined) delete process.env.EVAL_CONTROL_VARIANT;
  else process.env.EVAL_CONTROL_VARIANT = previousVariant;
  if (previousUnsafe === undefined) delete process.env.EVAL_ALLOW_UNSAFE_BASELINE;
  else process.env.EVAL_ALLOW_UNSAFE_BASELINE = previousUnsafe;

  const state: PlanState = {
    sessionId: "contract",
    phase: "intent_capture",
    turnCount: 1,
    clarificationCount: 0,
    intent: {},
    plan: null,
    lastTransitionAt: 0,
    history: [],
  };
  const projected = reduceObserveOnly(state, { type: "PLAN_SUBMITTED", plan });
  ok("observe_only reducer projects out-of-order submission", projected.phase === "plan_confirm" && projected.plan === plan);

  const at = "2026-08-01T00:00:00.000Z";
  const loopRun = run("loop", [
    { sequence: 1, at, type: "tool_start", toolName: "commit_itinerary", toolCallId: "early", phase: "planning" },
    { sequence: 2, at, type: "tool_end", toolName: "commit_itinerary", toolCallId: "early", phase: "planning", ok: true, result: {} },
    { sequence: 3, at, type: "user_message", detail: { commandType: "confirm_plan" } },
    { sequence: 4, at, type: "tool_start", toolName: "ask_clarification", toolCallId: "q1", phase: "planning" },
    { sequence: 5, at, type: "tool_start", toolName: "ask_clarification", toolCallId: "q2", phase: "planning" },
  ], 800);
  const fsmRun = run("fsm", [
    { sequence: 1, at, type: "tool_start", toolName: "commit_itinerary", toolCallId: "blocked", phase: "planning" },
    { sequence: 2, at, type: "tool_end", toolName: "commit_itinerary", toolCallId: "blocked", phase: "planning", ok: true, result: { error: true, code: "PHASE_GUARD" } },
    { sequence: 3, at, type: "user_message", detail: { commandType: "confirm_plan" } },
    { sequence: 4, at, type: "tool_start", toolName: "commit_itinerary", toolCallId: "legal", phase: "executing" },
    { sequence: 5, at, type: "tool_end", toolName: "commit_itinerary", toolCallId: "legal", phase: "executing", ok: true, result: {} },
  ], 1_000);
  const loopMetrics = measureControlRun(loopRun, grade(false, "loop"));
  const fsmMetrics = measureControlRun(fsmRun, grade(true, "fsm"));
  ok("metrics distinguish illegal attempt from execution",
    loopMetrics.illegalToolAttempts === 3 && loopMetrics.illegalToolExecutions === 1);
  ok("metrics identify phase guard blocks", fsmMetrics.blockedIllegalTools === 1 && fsmMetrics.illegalToolExecutions === 0);
  ok("metrics identify confirmation and clarification violations",
    loopMetrics.prematureCommit && loopMetrics.clarificationOverflow);

  const report = buildPairedControlReport([{
    scenarioId: "contract",
    trial: 1,
    loop: { run: loopRun, grade: grade(false, "loop") },
    fsm: { run: fsmRun, grade: grade(true, "fsm") },
  }]);
  ok("paired report builds the discordant success table",
    report.paired.successTable.fsmOnlyPass === 1 && report.paired.successRateDelta === 1);
  ok("paired report includes deterministic bootstrap intervals",
    report.paired.averageDurationDelta95Ci[0] === 200 && report.paired.averageDurationDelta95Ci[1] === 200);

  console.log(`\n=== Summary ===\n  Pass: ${passed}\n  Fail: ${failed}\n`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 2;
});
