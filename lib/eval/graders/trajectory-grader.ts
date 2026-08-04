import type { EvalCheck, EvalRun, EvalScenario } from "../types";

interface CompletedToolCall {
  name: string;
  sequence: number;
  phase?: string;
}

function isDomainError(result: unknown): boolean {
  return typeof result === "object" &&
    result !== null &&
    (result as { error?: unknown }).error === true;
}

function completedTools(run: EvalRun): CompletedToolCall[] {
  return run.events
    .filter((event) =>
      event.type === "tool_end" &&
      event.toolName &&
      event.ok !== false &&
      !isDomainError(event.result))
    .map((event) => ({
      name: event.toolName!,
      sequence: event.sequence,
      phase: event.phase,
    }));
}

export function gradeTrajectory(scenario: EvalScenario, run: EvalRun): EvalCheck[] {
  const calls = completedTools(run);
  const checks: EvalCheck[] = [];
  const count = (name: string) => calls.filter((call) => call.name === name).length;

  for (const name of scenario.oracle.requiredTools ?? []) {
    checks.push({
      id: `TRAJECTORY_REQUIRED_TOOL:${name}`,
      category: "trajectory",
      passed: count(name) > 0,
      severity: "hard",
      message: count(name) > 0 ? `${name} was called` : `${name} was not called`,
    });
  }

  for (const group of scenario.oracle.requiredToolGroups ?? []) {
    const matched = group.anyOf.filter((name) => count(name) > 0);
    checks.push({
      id: `TRAJECTORY_REQUIRED_GROUP:${group.id}`,
      category: "trajectory",
      passed: matched.length > 0,
      severity: "hard",
      message: matched.length > 0
        ? `${group.id} satisfied by ${matched.join(", ")}`
        : `${group.id} requires one of: ${group.anyOf.join(", ")}`,
      evidence: { anyOf: group.anyOf, matched },
    });
  }

  for (const name of scenario.oracle.forbiddenTools ?? []) {
    checks.push({
      id: `TRAJECTORY_FORBIDDEN_TOOL:${name}`,
      category: "trajectory",
      passed: count(name) === 0,
      severity: "hard",
      message: count(name) === 0 ? `${name} was not called` : `${name} was called ${count(name)} time(s)`,
    });
  }

  for (const rule of scenario.oracle.toolOrder ?? []) {
    const before = calls.find((call) => call.name === rule.before);
    const after = calls.find((call) => call.name === rule.after);
    const passed = !!before && !!after && before.sequence < after.sequence;
    checks.push({
      id: `TRAJECTORY_ORDER:${rule.before}<${rule.after}`,
      category: "trajectory",
      passed,
      severity: "hard",
      message: passed
        ? `${rule.before} occurred before ${rule.after}`
        : `Required order ${rule.before} < ${rule.after} was not observed`,
      evidence: { before, after },
    });
  }

  for (const [name, maximum] of Object.entries(scenario.oracle.maxToolCalls ?? {})) {
    if (maximum === undefined) continue;
    const actual = count(name);
    checks.push({
      id: `TRAJECTORY_MAX_CALLS:${name}`,
      category: "trajectory",
      passed: actual <= maximum,
      severity: "hard",
      message: `${name} successful call count is ${actual}/${maximum}`,
    });
  }

  if (scenario.oracle.requireConfirmationBeforeCommit) {
    const confirmation = run.events.find((event) =>
      event.type === "user_message" && event.detail?.commandType === "confirm_plan");
    const commit = calls.find((call) => call.name === "commit_itinerary");
    const passed = !commit || (!!confirmation && confirmation.sequence < commit.sequence);
    checks.push({
      id: "TRAJECTORY_CONFIRM_BEFORE_COMMIT",
      category: "trajectory",
      passed,
      severity: "hard",
      message: passed
        ? "No commit occurred before structured confirmation"
        : "commit_itinerary occurred before structured confirmation",
      evidence: { confirmation, commit },
    });
  }

  checks.push({
    id: "TRAJECTORY_NO_TOOL_ERRORS",
    category: "trajectory",
    passed: run.events.every((event) =>
      event.type !== "tool_end" || event.ok !== false && !isDomainError(event.result)),
    severity: "diagnostic",
    message: `${run.events.filter((event) =>
      event.type === "tool_end" && (event.ok === false || isDomainError(event.result))).length} tool error(s) observed`,
  });

  return checks;
}
