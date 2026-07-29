import { readFileSync } from "node:fs";
import type {
  PreferenceCandidate,
  PreferenceDataset,
  PreferenceExample,
  PreferenceLabel,
} from "./preference-types";

const LABELS = new Set<PreferenceLabel>(["a", "b", "tie"]);
const STATUSES = new Set(["seed", "reviewed", "adjudicated"]);

function assertCandidate(candidate: PreferenceCandidate, path: string): void {
  if (!candidate?.id || !candidate.summary) {
    throw new Error(`${path} requires id and summary`);
  }
  if (!Array.isArray(candidate.timeline) || candidate.timeline.length === 0) {
    throw new Error(`${path}.timeline must be non-empty`);
  }
  const budget = candidate.budget;
  if (!budget || ![budget.min, budget.likely, budget.max, budget.perPerson].every(Number.isFinite)) {
    throw new Error(`${path}.budget must contain finite min/likely/max/perPerson`);
  }
  if (!(budget.min <= budget.likely && budget.likely <= budget.max)) {
    throw new Error(`${path}.budget range must be ordered`);
  }
}

function assertExample(example: PreferenceExample, index: number): void {
  const path = `examples[${index}]`;
  if (!example.id || !example.version || !example.userRequest) {
    throw new Error(`${path} requires id, version and userRequest`);
  }
  if (!Array.isArray(example.tags)) throw new Error(`${path}.tags must be an array`);
  assertCandidate(example.candidateA, `${path}.candidateA`);
  assertCandidate(example.candidateB, `${path}.candidateB`);
  if (example.candidateA.id === example.candidateB.id) {
    throw new Error(`${path} candidates must have different ids`);
  }
  if (!STATUSES.has(example.annotation?.status)) {
    throw new Error(`${path}.annotation.status is invalid`);
  }
  if (!LABELS.has(example.annotation?.label)) {
    throw new Error(`${path}.annotation.label is invalid`);
  }
  if (!example.annotation.rubricVersion) {
    throw new Error(`${path}.annotation.rubricVersion is required`);
  }
  if (
    example.annotation.status !== "seed" &&
    (!example.annotation.annotatorIds || example.annotation.annotatorIds.length === 0)
  ) {
    throw new Error(`${path} reviewed annotations require annotatorIds`);
  }
}

export function parsePreferenceDataset(raw: unknown): PreferenceDataset {
  const dataset = raw as PreferenceDataset;
  if (dataset?.schemaVersion !== "preference-dataset-v2") {
    throw new Error("Expected schemaVersion preference-dataset-v2");
  }
  if (!dataset.name || !Array.isArray(dataset.examples) || dataset.examples.length === 0) {
    throw new Error("Preference dataset requires name and non-empty examples");
  }
  const ids = new Set<string>();
  dataset.examples.forEach((example, index) => {
    assertExample(example, index);
    if (ids.has(example.id)) throw new Error(`Duplicate preference example id ${example.id}`);
    ids.add(example.id);
  });
  return dataset;
}

export function loadPreferenceDataset(filePath: string): PreferenceDataset {
  return parsePreferenceDataset(JSON.parse(readFileSync(filePath, "utf8")));
}
