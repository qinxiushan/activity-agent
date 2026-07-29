import fs from "node:fs";
import type { EvalScenario } from "./types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Eval V1 dataset: ${message}`);
}

export function validateEvalDataset(value: unknown): EvalScenario[] {
  assert(Array.isArray(value), "root must be an array");
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    assert(item && typeof item === "object", `scenario ${index} must be an object`);
    const scenario = item as Partial<EvalScenario>;
    assert(typeof scenario.id === "string" && scenario.id.length > 0, `scenario ${index} requires id`);
    assert(!ids.has(scenario.id), `duplicate scenario id ${scenario.id}`);
    ids.add(scenario.id);
    assert(typeof scenario.version === "string" && scenario.version.length > 0, `${scenario.id} requires version`);
    assert(typeof scenario.description === "string" && scenario.description.length > 0, `${scenario.id} requires description`);
    assert(Array.isArray(scenario.tags) && scenario.tags.length > 0, `${scenario.id} requires tags`);
    assert(typeof scenario.user?.initialMessage === "string" && scenario.user.initialMessage.length > 0,
      `${scenario.id} requires initialMessage`);
    assert(typeof scenario.environment?.fixtureId === "string" && scenario.environment.fixtureId.length > 0,
      `${scenario.id} requires fixtureId`);
    assert(Array.isArray(scenario.oracle?.expectedFinalPhases) &&
      scenario.oracle.expectedFinalPhases.length > 0, `${scenario.id} requires expectedFinalPhases`);
    for (const step of scenario.user.steps ?? []) {
      assert(typeof step.id === "string" && step.id.length > 0, `${scenario.id} has step without id`);
      assert(!!step.trigger?.kind, `${scenario.id}/${step.id} requires trigger`);
      assert(!!step.action?.type, `${scenario.id}/${step.id} requires action`);
    }
  }
  return value as EvalScenario[];
}

export function loadEvalDataset(filePath: string): EvalScenario[] {
  return validateEvalDataset(JSON.parse(fs.readFileSync(filePath, "utf8")));
}
