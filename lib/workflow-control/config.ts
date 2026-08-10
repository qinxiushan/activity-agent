import type { WorkflowControlDescriptor, WorkflowControlVariant } from "./types";

const DEFAULT_VARIANT: WorkflowControlVariant = "phase_gated";

export function resolveWorkflowControlVariant(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkflowControlVariant {
  const requested = env.EVAL_CONTROL_VARIANT?.trim() || DEFAULT_VARIANT;
  if (requested !== "phase_gated" && requested !== "observe_only") {
    throw new Error(`Unknown EVAL_CONTROL_VARIANT: ${requested}`);
  }
  if (requested === "observe_only") {
    if (env.NODE_ENV === "production") {
      throw new Error("observe_only workflow control is forbidden in production");
    }
    if (env.EVAL_ALLOW_UNSAFE_BASELINE !== "1") {
      throw new Error(
        "observe_only requires EVAL_ALLOW_UNSAFE_BASELINE=1 and is only for isolated evaluation",
      );
    }
  }
  return requested;
}

export function getWorkflowControlDescriptor(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkflowControlDescriptor {
  const variant = resolveWorkflowControlVariant(env);
  const enforced = variant === "phase_gated";
  return {
    variant,
    enforcesPhaseGate: enforced,
    enforcesReducerPreconditions: enforced,
    enforcesClarificationLimit: enforced,
  };
}

export function isWorkflowControlEnforced(): boolean {
  return resolveWorkflowControlVariant() === "phase_gated";
}
