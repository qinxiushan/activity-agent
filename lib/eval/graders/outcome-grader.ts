import type { EvalCheck, EvalRun, EvalScenario } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => partialMatch(actual[index], item));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([key, value]) => partialMatch(actual[key], value));
  }
  return Object.is(actual, expected);
}

export function gradeOutcome(scenario: EvalScenario, run: EvalRun): EvalCheck[] {
  const state = run.finalState;
  const checks: EvalCheck[] = [{
    id: "OUTCOME_FINAL_STATE_PRESENT",
    category: "outcome",
    passed: !!state,
    severity: "hard",
    message: state ? "Final PlanState snapshot is present" : "Final PlanState snapshot is missing",
  }];
  if (!state) return checks;

  checks.push({
    id: "OUTCOME_FINAL_PHASE",
    category: "outcome",
    passed: scenario.oracle.expectedFinalPhases.includes(state.phase),
    severity: "hard",
    message: `Final phase is ${state.phase}`,
    evidence: {
      actual: state.phase,
      expected: scenario.oracle.expectedFinalPhases,
    },
  });

  if (scenario.oracle.requiredIntent) {
    checks.push({
      id: "OUTCOME_REQUIRED_INTENT",
      category: "outcome",
      passed: partialMatch(state.intent, scenario.oracle.requiredIntent),
      severity: "hard",
      message: "Captured intent contains the required scenario facts",
      evidence: {
        expected: scenario.oracle.requiredIntent,
        actual: state.intent,
      },
    });
  }

  if (scenario.oracle.planRequired) {
    checks.push({
      id: "OUTCOME_PLAN_PRESENT",
      category: "outcome",
      passed: !!state.plan,
      severity: "hard",
      message: state.plan ? "Canonical plan is present" : "Canonical plan is missing",
    });
  }

  if (scenario.oracle.maxClarifications !== undefined) {
    checks.push({
      id: "OUTCOME_CLARIFICATION_LIMIT",
      category: "outcome",
      passed: state.clarificationCount <= scenario.oracle.maxClarifications,
      severity: "hard",
      message: `Clarification count is ${state.clarificationCount}`,
      evidence: {
        actual: state.clarificationCount,
        maximum: scenario.oracle.maxClarifications,
      },
    });
  }

  return checks;
}
