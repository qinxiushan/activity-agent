import type {
  DebiasedJudgeResult,
  PreferenceCalibrationMetrics,
  PreferenceDataset,
  PreferenceLabel,
} from "./preference-types";

const LABELS: PreferenceLabel[] = ["a", "b", "tie"];
type Prediction = PreferenceLabel | "abstain";

function emptyConfusion(): PreferenceCalibrationMetrics["confusionMatrix"] {
  return Object.fromEntries(
    LABELS.map((actual) => [
      actual,
      { a: 0, b: 0, tie: 0, abstain: 0 },
    ]),
  ) as PreferenceCalibrationMetrics["confusionMatrix"];
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function macroF1(
  pairs: Array<{ actual: PreferenceLabel; predicted: PreferenceLabel }>,
): number {
  return LABELS.reduce((sum, label) => {
    const tp = pairs.filter((pair) => pair.actual === label && pair.predicted === label).length;
    const fp = pairs.filter((pair) => pair.actual !== label && pair.predicted === label).length;
    const fn = pairs.filter((pair) => pair.actual === label && pair.predicted !== label).length;
    const precision = safeRatio(tp, tp + fp);
    const recall = safeRatio(tp, tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return sum + f1;
  }, 0) / LABELS.length;
}

function cohenKappa(
  pairs: Array<{ actual: PreferenceLabel; predicted: PreferenceLabel }>,
): number {
  if (pairs.length === 0) return 0;
  const observed = safeRatio(
    pairs.filter((pair) => pair.actual === pair.predicted).length,
    pairs.length,
  );
  const expected = LABELS.reduce((sum, label) => {
    const actualRate = safeRatio(pairs.filter((pair) => pair.actual === label).length, pairs.length);
    const predictedRate = safeRatio(
      pairs.filter((pair) => pair.predicted === label).length,
      pairs.length,
    );
    return sum + actualRate * predictedRate;
  }, 0);
  return expected === 1 ? (observed === 1 ? 1 : 0) : (observed - expected) / (1 - expected);
}

export function calibratePreferenceJudge(
  dataset: PreferenceDataset,
  results: DebiasedJudgeResult[],
): PreferenceCalibrationMetrics {
  const reviewed = dataset.examples.filter((example) => example.annotation.status !== "seed");
  const resultById = new Map(results.map((result) => [result.exampleId, result]));
  const confusion = emptyConfusion();
  const coveredPairs: Array<{ actual: PreferenceLabel; predicted: PreferenceLabel }> = [];
  let positionConsistent = 0;

  for (const example of reviewed) {
    const result = resultById.get(example.id);
    if (!result) continue;
    const prediction = result.finalWinner as Prediction;
    confusion[example.annotation.label][prediction]++;
    if (result.positionConsistent) positionConsistent++;
    if (prediction !== "abstain") {
      coveredPairs.push({ actual: example.annotation.label, predicted: prediction });
    }
  }

  const judgedCount = reviewed.filter((example) => resultById.has(example.id)).length;
  const correct = coveredPairs.filter((pair) => pair.actual === pair.predicted).length;
  return {
    reviewedCount: reviewed.length,
    judgedCount,
    coverage: roundMetric(safeRatio(coveredPairs.length, reviewed.length)),
    exactAgreement: roundMetric(safeRatio(correct, coveredPairs.length)),
    macroF1: roundMetric(macroF1(coveredPairs)),
    cohenKappa: roundMetric(cohenKappa(coveredPairs)),
    positionConsistency: roundMetric(safeRatio(positionConsistent, judgedCount)),
    confusionMatrix: confusion,
  };
}
