import { isToolAllowedInPhase } from "../plan-state";
import type { EvalGrade, EvalRun } from "./types";

export interface ControlRunMetrics {
  hardPassed: boolean;
  durationMs: number;
  toolCallCount: number;
  toolAttemptCount: number;
  illegalToolAttempts: number;
  illegalToolExecutions: number;
  blockedIllegalTools: number;
  prematureCommit: boolean;
  clarificationOverflow: boolean;
  duplicateSubmission: boolean;
  duplicateSideEffect: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface PairedControlSample {
  scenarioId: string;
  trial: number;
  loop: { run: EvalRun; grade: EvalGrade };
  fsm: { run: EvalRun; grade: EvalGrade };
}

function resultCode(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const value = result as { code?: unknown; error?: unknown; details?: unknown };
  if (typeof value.code === "string") return value.code;
  if (typeof value.error === "object") return resultCode(value.error);
  return resultCode(value.details);
}

function isPhaseGuardResult(result: unknown): boolean {
  if (resultCode(result) === "PHASE_GUARD") return true;
  try {
    return /PHASE_GUARD|not allowed in phase/i.test(JSON.stringify(result));
  } catch {
    return false;
  }
}

function isSuccessfulResult(event: EvalRun["events"][number]): boolean {
  if (event.type !== "tool_end" || event.ok === false) return false;
  return !(event.result && typeof event.result === "object" &&
    (event.result as { error?: unknown }).error === true);
}

function matchingEnd(run: EvalRun, start: EvalRun["events"][number]) {
  return run.events.find((event) =>
    event.type === "tool_end" &&
    event.sequence > start.sequence &&
    (start.toolCallId
      ? event.toolCallId === start.toolCallId
      : event.toolName === start.toolName));
}

export function measureControlRun(run: EvalRun, grade: EvalGrade): ControlRunMetrics {
  const starts = run.events.filter((event) => event.type === "tool_start" && event.toolName);
  const illegalStarts = starts.filter((event) =>
    event.phase !== undefined && !isToolAllowedInPhase(event.toolName!, event.phase));
  const illegalEnds = illegalStarts.map((start) => matchingEnd(run, start)).filter(Boolean);
  const successfulEnds = run.events.filter(isSuccessfulResult);
  const successfulCount = (toolName: string) => successfulEnds.filter((event) => event.toolName === toolName).length;
  const confirmation = run.events.find((event) =>
    event.type === "user_message" && event.detail?.commandType === "confirm_plan");
  const firstCommit = starts.find((event) => event.toolName === "commit_itinerary");

  return {
    hardPassed: grade.hardPassed,
    durationMs: run.metrics.durationMs,
    toolCallCount: run.metrics.toolCallCount,
    toolAttemptCount: starts.length,
    illegalToolAttempts: illegalStarts.length,
    illegalToolExecutions: illegalEnds.filter((event) => event && isSuccessfulResult(event)).length,
    blockedIllegalTools: illegalEnds.filter((event) => isPhaseGuardResult(event?.result)).length,
    prematureCommit: Boolean(firstCommit && (!confirmation || firstCommit.sequence < confirmation.sequence)),
    clarificationOverflow: starts.filter((event) => event.toolName === "ask_clarification").length > 1,
    duplicateSubmission: successfulCount("submit_plan") > 1,
    duplicateSideEffect: successfulCount("commit_itinerary") > 1,
    inputTokens: run.metrics.inputTokens,
    outputTokens: run.metrics.outputTokens,
    costUsd: run.metrics.costUsd,
  };
}

function rate(count: number, total: number): number {
  return Number((count / Math.max(1, total)).toFixed(4));
}

function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return [Number(Math.max(0, center - margin).toFixed(4)), Number(Math.min(1, center + margin).toFixed(4))];
}

function binomialLowerTail(n: number, k: number): number {
  let probability = Math.pow(0.5, n);
  let sum = probability;
  for (let index = 1; index <= k; index++) {
    probability *= (n - index + 1) / index;
    sum += probability;
  }
  return sum;
}

function mcnemarExact(loopOnly: number, fsmOnly: number): number {
  const discordant = loopOnly + fsmOnly;
  if (discordant === 0) return 1;
  return Number(Math.min(1, 2 * binomialLowerTail(discordant, Math.min(loopOnly, fsmOnly))).toFixed(6));
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function bootstrapMeanCi(values: number[], iterations = 2_000): [number, number] {
  if (values.length === 0) return [0, 0];
  let seed = 0x5eed1234;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0;
    for (let index = 0; index < values.length; index++) {
      sum += values[Math.floor(random() * values.length)]!;
    }
    means.push(sum / values.length);
  }
  return [Number(percentile(means, 0.025).toFixed(2)), Number(percentile(means, 0.975).toFixed(2))];
}

function summarize(runs: ControlRunMetrics[]) {
  const successes = runs.filter((item) => item.hardPassed).length;
  const totalAttempts = runs.reduce((sum, item) => sum + item.illegalToolAttempts, 0);
  const totalTools = runs.reduce((sum, item) => sum + item.toolCallCount, 0);
  const totalAttemptsAcrossRuns = runs.reduce((sum, item) => sum + item.toolAttemptCount, 0);
  const costs = runs.map((item) => item.costUsd).filter((value): value is number => value !== undefined);
  return {
    runCount: runs.length,
    hardSuccessRate: rate(successes, runs.length),
    hardSuccessRate95Ci: wilson(successes, runs.length),
    illegalToolAttemptRate: rate(totalAttempts, totalAttemptsAcrossRuns),
    illegalToolExecutionRate: rate(runs.reduce((sum, item) => sum + item.illegalToolExecutions, 0), totalAttempts),
    blockedIllegalToolRate: rate(runs.reduce((sum, item) => sum + item.blockedIllegalTools, 0), totalAttempts),
    prematureCommitRate: rate(runs.filter((item) => item.prematureCommit).length, runs.length),
    clarificationOverflowRate: rate(runs.filter((item) => item.clarificationOverflow).length, runs.length),
    duplicateSubmissionRate: rate(runs.filter((item) => item.duplicateSubmission).length, runs.length),
    duplicateSideEffectRate: rate(runs.filter((item) => item.duplicateSideEffect).length, runs.length),
    averageDurationMs: Math.round(runs.reduce((sum, item) => sum + item.durationMs, 0) / Math.max(1, runs.length)),
    averageToolCalls: Number((totalTools / Math.max(1, runs.length)).toFixed(2)),
    costPerSuccessfulWorkflow: costs.length === runs.length && successes > 0
      ? Number((costs.reduce((sum, value) => sum + value, 0) / successes).toFixed(6))
      : undefined,
  };
}

export function buildPairedControlReport(samples: PairedControlSample[]) {
  const measured = samples.map((sample) => ({
    scenarioId: sample.scenarioId,
    trial: sample.trial,
    loop: measureControlRun(sample.loop.run, sample.loop.grade),
    fsm: measureControlRun(sample.fsm.run, sample.fsm.grade),
  }));
  const bothPass = measured.filter((item) => item.loop.hardPassed && item.fsm.hardPassed).length;
  const loopOnlyPass = measured.filter((item) => item.loop.hardPassed && !item.fsm.hardPassed).length;
  const fsmOnlyPass = measured.filter((item) => !item.loop.hardPassed && item.fsm.hardPassed).length;
  const bothFail = measured.length - bothPass - loopOnlyPass - fsmOnlyPass;
  const durationDeltas = measured.map((item) => item.fsm.durationMs - item.loop.durationMs);
  const toolDeltas = measured.map((item) => item.fsm.toolCallCount - item.loop.toolCallCount);
  return {
    schemaVersion: "agent-control-ab-v1",
    generatedAt: new Date().toISOString(),
    pairCount: measured.length,
    variants: {
      observeOnly: summarize(measured.map((item) => item.loop)),
      phaseGated: summarize(measured.map((item) => item.fsm)),
    },
    paired: {
      successTable: { bothPass, loopOnlyPass, fsmOnlyPass, bothFail },
      successRateDelta: rate(fsmOnlyPass - loopOnlyPass, measured.length),
      mcnemarExactPValue: mcnemarExact(loopOnlyPass, fsmOnlyPass),
      averageDurationDeltaMs: Number((durationDeltas.reduce((a, b) => a + b, 0) / Math.max(1, durationDeltas.length)).toFixed(2)),
      averageDurationDelta95Ci: bootstrapMeanCi(durationDeltas),
      averageToolCallDelta: Number((toolDeltas.reduce((a, b) => a + b, 0) / Math.max(1, toolDeltas.length)).toFixed(2)),
      averageToolCallDelta95Ci: bootstrapMeanCi(toolDeltas),
    },
    samples: measured,
  };
}
