import type { EvalCheck, EvalRun, EvalScenario } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeComparableText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\p{Z}]/gu, "");
}

function normalizeCity(value: string): string {
  return normalizeComparableText(value).replace(/市$/u, "");
}

function placeNameVariants(value: string, city?: string): Set<string> {
  const place = normalizeComparableText(value);
  const variants = new Set([place]);
  if (!city) return variants;
  const cityPrefix = normalizeCity(city);
  if (cityPrefix && place.startsWith(cityPrefix)) {
    const withoutCity = place.slice(cityPrefix.length);
    variants.add(withoutCity);
    if (withoutCity.startsWith("市")) variants.add(withoutCity.slice(1));
  }
  return variants;
}

function placePartialMatch(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!isRecord(actual)) return false;
  const expectedCity = typeof expected.city === "string" ? expected.city : undefined;
  const actualCity = typeof actual.city === "string" ? actual.city : undefined;
  if (
    expectedCity !== undefined &&
    (actualCity === undefined || normalizeCity(actualCity) !== normalizeCity(expectedCity))
  ) {
    return false;
  }
  if (typeof expected.name === "string") {
    if (typeof actual.name !== "string") return false;
    const city = expectedCity ?? actualCity;
    const actualNames = placeNameVariants(actual.name, city);
    const expectedNames = placeNameVariants(expected.name, city);
    if (![...expectedNames].some((name) => actualNames.has(name))) {
      return false;
    }
  }
  return Object.entries(expected).every(([key, value]) =>
    key === "name" || key === "city" || partialMatch(actual[key], value));
}

function partialMatch(actual: unknown, expected: unknown, path: string[] = []): boolean {
  if (expected === undefined) return true;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((item, index) => partialMatch(actual[index], item, [...path, String(index)]));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const field = path.at(-1);
    if (field === "departurePoint" || field === "endPoint") {
      return placePartialMatch(actual, expected);
    }
    return Object.entries(expected).every(([key, value]) =>
      partialMatch(actual[key], value, [...path, key]));
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
