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

const SEMANTIC_ALIASES: Record<string, Record<string, string>> = {
  dietaryRestrictions: {
    素食: "vegetarian",
    素食主义: "vegetarian",
    vegetarian: "vegetarian",
    纯素: "vegan",
    纯素食: "vegan",
    vegan: "vegan",
    清真: "halal",
    halal: "halal",
    低碳水: "lowcarb",
    低碳: "lowcarb",
    lowcarb: "lowcarb",
  },
};

function semanticField(path: string[]): string | undefined {
  return path.find((part) => SEMANTIC_ALIASES[part]);
}

function normalizeSemanticValue(field: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = normalizeComparableText(value);
  return SEMANTIC_ALIASES[field]?.[normalized] ?? normalized;
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
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    const field = semanticField(path);
    if (field) {
      const actualValues = actual.map((value) => normalizeSemanticValue(field, value)).sort();
      const expectedValues = expected.map((value) => normalizeSemanticValue(field, value)).sort();
      return expectedValues.every((value, index) => Object.is(actualValues[index], value));
    }
    return expected.every((item, index) =>
      partialMatch(actual[index], item, [...path, String(index)]));
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
  const field = semanticField(path);
  return field
    ? Object.is(normalizeSemanticValue(field, actual), normalizeSemanticValue(field, expected))
    : Object.is(actual, expected);
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
