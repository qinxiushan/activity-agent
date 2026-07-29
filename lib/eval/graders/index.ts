import { gradeConstraints } from "./constraint-grader";
import { gradeOutcome } from "./outcome-grader";
import { gradeTrajectory } from "./trajectory-grader";
import type { EvalGrade, EvalRun, EvalScenario } from "../types";

export function gradeEvalRun(scenario: EvalScenario, run: EvalRun): EvalGrade {
  const checks = [
    ...gradeOutcome(scenario, run),
    ...gradeConstraints(scenario, run),
    ...gradeTrajectory(scenario, run),
  ];
  const failed = checks.filter((check) => !check.passed);
  const hardFailed = failed.filter((check) => check.severity === "hard");
  return {
    scenarioId: scenario.id,
    runId: run.runId,
    hardPassed: hardFailed.length === 0,
    checks,
    failureCodes: hardFailed.map((check) => check.id),
    summary: {
      passed: checks.length - failed.length,
      failed: failed.length,
      hardFailed: hardFailed.length,
    },
  };
}
