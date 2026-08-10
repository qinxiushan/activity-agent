import { isToolAllowedInPhase, TOOL_PHASE_RULES, type PlanPhase } from "../plan-state";
import { getWorkflowControlDescriptor } from "./config";
import type { WorkflowToolDecision } from "./types";

export function evaluateWorkflowToolCall(
  toolName: string,
  currentPhase: PlanPhase,
): WorkflowToolDecision {
  const legal = isToolAllowedInPhase(toolName, currentPhase);
  const reason = legal
    ? undefined
    : `Tool "${toolName}" is not allowed in phase "${currentPhase}". ` +
      `Allowed phases: [${TOOL_PHASE_RULES[toolName]?.join(", ") ?? "any"}].`;
  return {
    allowed: legal || !getWorkflowControlDescriptor().enforcesPhaseGate,
    wouldBlock: !legal,
    currentPhase,
    reason,
  };
}
