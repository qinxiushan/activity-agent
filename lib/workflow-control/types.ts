import type { PlanPhase } from "../plan-state";

export type WorkflowControlVariant = "phase_gated" | "observe_only";

export interface WorkflowControlDescriptor {
  variant: WorkflowControlVariant;
  enforcesPhaseGate: boolean;
  enforcesReducerPreconditions: boolean;
  enforcesClarificationLimit: boolean;
  promptHash?: string;
  toolContractHash?: string;
}

export interface WorkflowToolDecision {
  allowed: boolean;
  wouldBlock: boolean;
  currentPhase: PlanPhase;
  reason?: string;
}
