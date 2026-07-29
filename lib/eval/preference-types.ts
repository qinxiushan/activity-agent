export const PREFERENCE_DIMENSIONS = [
  "constraintSatisfaction",
  "feasibility",
  "personalization",
  "diversity",
  "costTransparency",
] as const;

export type PreferenceDimension = typeof PREFERENCE_DIMENSIONS[number];
export type PreferenceLabel = "a" | "b" | "tie";
export type PreferenceAnnotationStatus = "seed" | "reviewed" | "adjudicated";

export interface PreferenceCandidate {
  id: string;
  summary: string;
  timeline: Array<{
    startTime: string;
    endTime: string;
    type: "departure" | "transit" | "activity" | "meal" | "rest";
    name: string;
    notes?: string;
  }>;
  budget: {
    min: number;
    likely: number;
    max: number;
    perPerson: number;
    status: "within" | "near_limit" | "exceeded" | "unknown";
    basis?: string[];
  };
  warnings?: string[];
}

export interface PreferenceAnnotation {
  status: PreferenceAnnotationStatus;
  label: PreferenceLabel;
  rubricVersion: string;
  confidence?: number;
  annotatorIds?: string[];
  rationale?: string;
}

export interface PreferenceExample {
  id: string;
  version: string;
  tags: string[];
  userRequest: string;
  criteria?: string[];
  candidateA: PreferenceCandidate;
  candidateB: PreferenceCandidate;
  annotation: PreferenceAnnotation;
}

export interface PreferenceDataset {
  schemaVersion: "preference-dataset-v2";
  name: string;
  description: string;
  examples: PreferenceExample[];
}

export interface DimensionScore {
  a: number;
  b: number;
}

export interface JudgeVerdict {
  winner: PreferenceLabel;
  confidence: number;
  dimensions: Record<PreferenceDimension, DimensionScore>;
  hardConstraintViolations: {
    a: string[];
    b: string[];
  };
  rationale: string;
}

export interface PairwiseJudgeInput {
  exampleId: string;
  userRequest: string;
  criteria: string[];
  candidateA: PreferenceCandidate;
  candidateB: PreferenceCandidate;
}

export interface PairwiseJudge {
  readonly id: string;
  judge(input: PairwiseJudgeInput): Promise<JudgeVerdict>;
}

export interface DebiasedJudgeResult {
  exampleId: string;
  forward: JudgeVerdict;
  reverse: JudgeVerdict;
  reverseMappedWinner: PreferenceLabel;
  finalWinner: PreferenceLabel | "abstain";
  positionConsistent: boolean;
  confidence: number;
  diagnostics: string[];
}

export interface PreferenceCalibrationMetrics {
  reviewedCount: number;
  judgedCount: number;
  coverage: number;
  exactAgreement: number;
  macroF1: number;
  cohenKappa: number;
  positionConsistency: number;
  confusionMatrix: Record<PreferenceLabel, Record<PreferenceLabel | "abstain", number>>;
}

export interface PreferenceReviewRecord {
  exampleId: string;
  blindedLeftId: string;
  blindedRightId: string;
  leftCandidateSource: "a" | "b";
  rightCandidateSource: "a" | "b";
}

export interface PreferenceReviewPacket {
  schemaVersion: "preference-review-v2";
  packetId: string;
  rubricVersion: string;
  createdAt: string;
  items: Array<{
    exampleId: string;
    userRequest: string;
    criteria: string[];
    left: PreferenceCandidate;
    right: PreferenceCandidate;
    label?: "left" | "right" | "tie";
    confidence?: number;
    rationale?: string;
  }>;
  manifest: PreferenceReviewRecord[];
}
