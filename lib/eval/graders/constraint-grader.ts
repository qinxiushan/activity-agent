import type { BudgetBreakdown } from "../../budget-service";
import type { EvalCheck, EvalRun, EvalScenario } from "../types";

function minutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function timelineIsChronological(
  timeline: Array<{ startTime: string; endTime: string }>,
): boolean {
  let previousEnd = -1;
  return timeline.every((item) => {
    const start = minutes(item.startTime);
    const end = minutes(item.endTime);
    if (start === null || end === null || end < start || start < previousEnd) return false;
    previousEnd = end;
    return true;
  });
}

function budgetInvariantHolds(budget: BudgetBreakdown): boolean {
  return budget.minimumTotal <= budget.likelyTotal &&
    budget.likelyTotal <= budget.maximumTotal &&
    budget.projectedTotal === budget.knownTotal + budget.estimatedTotal + budget.reserveTotal &&
    budget.projectedPerPerson === Number((budget.projectedTotal / budget.partySize).toFixed(2));
}

export function gradeConstraints(scenario: EvalScenario, run: EvalRun): EvalCheck[] {
  const checks: EvalCheck[] = [];
  const plan = run.finalState?.plan;

  if (scenario.oracle.requireNonEmptyTimeline) {
    checks.push({
      id: "CONSTRAINT_NON_EMPTY_TIMELINE",
      category: "constraint",
      passed: !!plan && plan.timeline.length > 0,
      severity: "hard",
      message: plan?.timeline.length
        ? `Timeline contains ${plan.timeline.length} entries`
        : "Timeline is empty or unavailable",
    });
  }

  if (scenario.oracle.requireChronologicalTimeline) {
    const passed = !!plan && timelineIsChronological(plan.timeline);
    checks.push({
      id: "CONSTRAINT_CHRONOLOGICAL_TIMELINE",
      category: "constraint",
      passed,
      severity: "hard",
      message: passed ? "Timeline is chronological and non-overlapping" : "Timeline overlaps or has invalid times",
      evidence: plan?.timeline,
    });
  }

  if (scenario.oracle.requireBudgetInvariant) {
    const budget = plan?.budgetBreakdown;
    const passed = !!budget && budgetInvariantHolds(budget);
    checks.push({
      id: "CONSTRAINT_BUDGET_INVARIANT",
      category: "constraint",
      passed,
      severity: "hard",
      message: passed ? "Budget arithmetic and ranges are consistent" : "Budget arithmetic or ranges are inconsistent",
      evidence: budget,
    });
  }

  if (scenario.oracle.requireWarningsPreserved) {
    const validation = [...run.events].reverse().find((event) =>
      event.type === "tool_end" && event.toolName === "validate_itinerary" && event.ok !== false);
    const result = validation?.result as { warnings?: unknown[] } | undefined;
    const expectedWarnings = Array.isArray(result?.warnings) ? result.warnings.length : 0;
    const actualWarnings = plan?.warnings?.length ?? 0;
    checks.push({
      id: "CONSTRAINT_WARNINGS_PRESERVED",
      category: "constraint",
      passed: expectedWarnings === actualWarnings,
      severity: "hard",
      message: `Canonical plan preserved ${actualWarnings}/${expectedWarnings} validation warnings`,
      evidence: { expectedWarnings, actualWarnings },
    });
  }

  return checks;
}
