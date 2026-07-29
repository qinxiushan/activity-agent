import path from "node:path";
import { loadPreferenceDataset, parsePreferenceDataset } from "../lib/eval/preference-dataset";
import { calibratePreferenceJudge } from "../lib/eval/preference-calibration";
import {
  judgeWithPositionDebias,
  mapReversedWinner,
  parseJudgeVerdict,
} from "../lib/eval/pairwise-judge";
import {
  applyPreferenceReview,
  createPreferenceReviewBundle,
} from "../lib/eval/preference-review";
import type {
  DebiasedJudgeResult,
  JudgeVerdict,
  PairwiseJudge,
  PairwiseJudgeInput,
  PreferenceDataset,
  PreferenceLabel,
} from "../lib/eval/preference-types";

let pass = 0;
let fail = 0;

function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function rejects(label: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    ok(label, false);
  } catch {
    ok(label, true);
  }
}

function verdict(winner: PreferenceLabel, confidence = 0.9): JudgeVerdict {
  const score = winner === "a" ? { a: 5, b: 3 } : winner === "b" ? { a: 3, b: 5 } : { a: 4, b: 4 };
  return {
    winner,
    confidence,
    dimensions: {
      constraintSatisfaction: score,
      feasibility: score,
      personalization: score,
      diversity: score,
      costTransparency: score,
    },
    hardConstraintViolations: { a: [], b: [] },
    rationale: "合同测试判定",
  };
}

class SequenceJudge implements PairwiseJudge {
  readonly id = "sequence";
  private index = 0;
  constructor(private readonly verdicts: JudgeVerdict[]) {}
  async judge(_input: PairwiseJudgeInput): Promise<JudgeVerdict> {
    return this.verdicts[this.index++] ?? this.verdicts.at(-1)!;
  }
}

function judgeResult(
  exampleId: string,
  finalWinner: PreferenceLabel | "abstain",
  positionConsistent = finalWinner !== "abstain",
): DebiasedJudgeResult {
  return {
    exampleId,
    forward: verdict(finalWinner === "abstain" ? "a" : finalWinner),
    reverse: verdict(finalWinner === "a" ? "b" : finalWinner === "b" ? "a" : "tie"),
    reverseMappedWinner: finalWinner === "abstain" ? "b" : finalWinner,
    finalWinner,
    positionConsistent,
    confidence: positionConsistent ? 0.9 : 0,
    diagnostics: positionConsistent ? [] : ["POSITION_DISAGREEMENT:a/b"],
  };
}

async function main(): Promise<void> {
  console.log("\n=== Eval V2 Contract Test ===\n");
  const dataset = loadPreferenceDataset(
    path.resolve("evals/datasets/preference-seed-v2.json"),
  );
  ok("dataset has 12 seed pairs", dataset.examples.length === 12, String(dataset.examples.length));
  ok("all example ids are unique", new Set(dataset.examples.map((item) => item.id)).size === 12);
  ok("all labels remain seed", dataset.examples.every((item) => item.annotation.status === "seed"));
  ok("dataset covers three cities", ["北京", "上海", "深圳"].every((city) =>
    dataset.examples.some((item) => item.tags.includes(city))));
  ok("dataset covers a/b/tie", ["a", "b", "tie"].every((label) =>
    dataset.examples.some((item) => item.annotation.label === label)));
  ok("dataset covers hard constraints", dataset.examples.some((item) =>
    item.tags.includes("hard-constraint")));
  ok("dataset covers personalization", dataset.examples.some((item) =>
    item.tags.includes("personalization")));

  const serialized = JSON.stringify(verdict("a"));
  ok("strict verdict parser accepts valid JSON", parseJudgeVerdict(serialized).winner === "a");
  ok("verdict parser accepts fenced JSON", parseJudgeVerdict(`\`\`\`json\n${serialized}\n\`\`\``).winner === "a");
  await rejects("verdict parser rejects invalid scores", () =>
    parseJudgeVerdict(serialized.replace('"a":5', '"a":9')));
  await rejects("verdict parser rejects invalid confidence", () =>
    parseJudgeVerdict(serialized.replace('"confidence":0.9', '"confidence":2')));
  ok("reverse maps a to b", mapReversedWinner("a") === "b");
  ok("reverse keeps tie", mapReversedWinner("tie") === "tie");

  const example = dataset.examples[0];
  const input: PairwiseJudgeInput = {
    exampleId: example.id,
    userRequest: example.userRequest,
    criteria: example.criteria ?? [],
    candidateA: example.candidateA,
    candidateB: example.candidateB,
  };
  const consistent = await judgeWithPositionDebias(
    new SequenceJudge([verdict("a", 0.9), verdict("b", 0.8)]),
    input,
  );
  ok("position-consistent verdict is accepted", consistent.finalWinner === "a");
  ok("debiased confidence uses conservative minimum", consistent.confidence === 0.8);
  const inconsistent = await judgeWithPositionDebias(
    new SequenceJudge([verdict("a"), verdict("a")]),
    input,
  );
  ok("position disagreement abstains", inconsistent.finalWinner === "abstain");
  ok("position disagreement emits diagnostic", inconsistent.diagnostics[0]?.startsWith("POSITION_DISAGREEMENT"));

  const bundle = createPreferenceReviewBundle(dataset, { packetId: "contract-packet" });
  ok("review packet omits private manifest", bundle.packet.manifest === undefined);
  ok("manifest is stored separately", bundle.manifest.records.length === 12);
  ok("review candidate ids are blinded", bundle.packet.items.every((item) =>
    item.left.id === "candidate-left" && item.right.id === "candidate-right"));
  const incomplete = structuredClone(bundle.packet);
  await rejects("incomplete review cannot be applied", () =>
    applyPreferenceReview(dataset, incomplete, bundle.manifest, "reviewer-1"));
  const completed = structuredClone(bundle.packet);
  completed.items.forEach((item) => {
    item.label = "left";
    item.confidence = 0.8;
    item.rationale = "人工合同标注";
  });
  const reviewed = applyPreferenceReview(dataset, completed, bundle.manifest, "reviewer-1");
  ok("completed review marks every item reviewed", reviewed.examples.every((item) =>
    item.annotation.status === "reviewed"));
  ok("completed review records annotator", reviewed.examples.every((item) =>
    item.annotation.annotatorIds?.[0] === "reviewer-1"));
  ok("reviewed dataset passes runtime validation", parsePreferenceDataset(reviewed).examples.length === 12);

  const seedMetrics = calibratePreferenceJudge(dataset, []);
  ok("seed labels are excluded from calibration", seedMetrics.reviewedCount === 0);
  const calibrationDataset: PreferenceDataset = {
    ...dataset,
    examples: dataset.examples.slice(0, 3).map((item, index) => ({
      ...item,
      annotation: {
        status: "reviewed" as const,
        label: (["a", "b", "tie"] as PreferenceLabel[])[index],
        rubricVersion: "contract",
        annotatorIds: ["human-1"],
      },
    })),
  };
  const metrics = calibratePreferenceJudge(calibrationDataset, [
    judgeResult(calibrationDataset.examples[0].id, "a"),
    judgeResult(calibrationDataset.examples[1].id, "abstain", false),
    judgeResult(calibrationDataset.examples[2].id, "tie"),
  ]);
  ok("calibration counts reviewed gold", metrics.reviewedCount === 3);
  ok("calibration counts judge coverage", metrics.coverage === 0.6667, String(metrics.coverage));
  ok("covered predictions exactly agree", metrics.exactAgreement === 1);
  ok("macro F1 penalizes uncovered class", metrics.macroF1 === 0.6667, String(metrics.macroF1));
  ok("Cohen kappa is perfect on covered pairs", metrics.cohenKappa === 1);
  ok("position consistency includes abstention", metrics.positionConsistency === 0.6667);
  ok("confusion matrix records abstain", metrics.confusionMatrix.b.abstain === 1);

  console.log(`\n=== Summary ===\n  Pass: ${pass}\n  Fail: ${fail}\n`);
  if (fail > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
