import type { CapturedIntent, PlanPhase, ProposedPlan } from "../plan-state";

export type EvalEventType =
  | "user_message"
  | "assistant_message"
  | "tool_start"
  | "tool_end"
  | "phase_change"
  | "state_snapshot"
  | "error";

export interface EvalTraceEvent {
  sequence: number;
  at: string;
  type: EvalEventType;
  phase?: PlanPhase;
  message?: string;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  ok?: boolean;
  detail?: Record<string, unknown>;
}

export interface EvalStateSnapshot {
  phase: PlanPhase;
  turnCount: number;
  clarificationCount: number;
  intent?: CapturedIntent;
  plan?: ProposedPlan;
}

export interface EvalOrderRule {
  before: string;
  after: string;
}

export interface EvalOracle {
  expectedFinalPhases: PlanPhase[];
  requiredIntent?: Partial<CapturedIntent>;
  planRequired?: boolean;
  requireNonEmptyTimeline?: boolean;
  requireChronologicalTimeline?: boolean;
  requireBudgetInvariant?: boolean;
  requireWarningsPreserved?: boolean;
  requiredTools?: string[];
  forbiddenTools?: string[];
  toolOrder?: EvalOrderRule[];
  maxToolCalls?: Partial<Record<string, number>>;
  maxClarifications?: number;
  requireConfirmationBeforeCommit?: boolean;
}

export interface EvalUserGoal {
  date?: string;
  startTime?: string;
  endTime?: string;
  departurePoint?: string;
  partySize?: number;
  budgetPerPerson?: number;
  preferences?: string[];
}

export type ScriptedUserTrigger =
  | { kind: "phase"; phase: PlanPhase }
  | { kind: "assistant_includes"; text: string }
  | { kind: "tool_called"; toolName: string };

export type ScriptedUserAction =
  | { type: "message"; message: string }
  | { type: "confirm_plan" }
  | { type: "clarification_answers"; answers: Record<string, unknown> }
  | { type: "stop" };

export interface ScriptedUserStep {
  id: string;
  trigger: ScriptedUserTrigger;
  action: ScriptedUserAction;
  once?: boolean;
}

export interface EvalScenario {
  id: string;
  version: string;
  description: string;
  tags: string[];
  user: {
    initialMessage: string;
    hiddenGoal?: EvalUserGoal;
    steps?: ScriptedUserStep[];
  };
  environment: {
    fixtureId: string;
    injectedFailures?: Array<{
      operation: string;
      callIndex: number;
      message: string;
    }>;
  };
  oracle: EvalOracle;
}

export interface EvalTarget {
  provider: string;
  modelId: string;
  promptVersion?: string;
  appVersion?: string;
}

export interface EvalRun {
  runId: string;
  scenarioId: string;
  scenarioVersion: string;
  target: EvalTarget;
  startedAt: string;
  endedAt: string;
  events: EvalTraceEvent[];
  finalState?: EvalStateSnapshot;
  metrics: {
    durationMs: number;
    toolCallCount: number;
    errorCount: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}

export type EvalCheckCategory =
  | "outcome"
  | "constraint"
  | "trajectory"
  | "infrastructure";

export interface EvalCheck {
  id: string;
  category: EvalCheckCategory;
  passed: boolean;
  severity: "hard" | "diagnostic";
  message: string;
  evidence?: unknown;
}

export interface EvalGrade {
  scenarioId: string;
  runId: string;
  hardPassed: boolean;
  checks: EvalCheck[];
  failureCodes: string[];
  summary: {
    passed: number;
    failed: number;
    hardFailed: number;
  };
}
