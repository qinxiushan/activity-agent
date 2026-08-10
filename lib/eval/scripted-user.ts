import { createHash } from "node:crypto";
import type {
  EvalAgentCommand,
  EvalStateSnapshot,
  EvalTraceEvent,
  ScriptedUserAction,
  ScriptedUserStep,
} from "./types";

function planHash(state: EvalStateSnapshot): string {
  if (!state.plan) throw new Error("Cannot confirm: canonical plan is missing");
  const actionable = {
    timeline: state.plan.timeline.map((item) => ({
      poiId: item.poiId ?? "",
      startTime: item.startTime,
      endTime: item.endTime,
      type: item.type,
    })),
    totalCost: state.plan.totalCost,
  };
  return createHash("sha256").update(JSON.stringify(actionable)).digest("hex").slice(0, 16);
}

function matches(
  step: ScriptedUserStep,
  events: readonly EvalTraceEvent[],
  state: EvalStateSnapshot,
): boolean {
  const trigger = step.trigger;
  if (trigger.kind === "phase") return state.phase === trigger.phase;
  if (trigger.kind === "plan_available") return Boolean(state.plan);
  if (trigger.kind === "clarification_available") {
    return state.pendingClarification?.status === "pending";
  }
  if (trigger.kind === "assistant_includes") {
    return events.some((event) =>
      event.type === "assistant_message" && event.message?.includes(trigger.text));
  }
  return events.some((event) =>
    event.type === "tool_end" && event.toolName === trigger.toolName && event.ok !== false);
}

export class ScriptedUser {
  private readonly consumed = new Set<string>();

  constructor(private readonly steps: ScriptedUserStep[]) {}

  next(events: readonly EvalTraceEvent[], state: EvalStateSnapshot): {
    step: ScriptedUserStep;
    command?: EvalAgentCommand;
    stop: boolean;
  } | null {
    const step = this.steps.find((candidate) =>
      (!candidate.once || !this.consumed.has(candidate.id)) &&
      matches(candidate, events, state));
    if (!step) return null;
    if (step.once !== false) this.consumed.add(step.id);
    if (step.action.type === "stop") return { step, stop: true };
    return { step, command: this.toCommand(step.action, state), stop: false };
  }

  private toCommand(action: Exclude<ScriptedUserAction, { type: "stop" }>, state: EvalStateSnapshot): EvalAgentCommand {
    if (action.type === "message") {
      return { type: "prompt", message: action.message };
    }
    if (action.type === "confirm_plan") {
      return { type: "confirm_plan", planHash: planHash(state) };
    }
    const clarificationId = state.pendingClarification?.status === "pending"
      ? state.pendingClarification.id
      : undefined;
    if (!clarificationId) throw new Error("Cannot answer clarification: no pending clarification is present");
    const answers = Object.fromEntries(
      (state.pendingClarification?.questions ?? []).flatMap((question) => {
        const value = action.answers[question.id] ?? action.answers[question.field];
        return value === undefined ? [] : [[question.id, value]];
      }),
    );
    return {
      type: "clarification_response",
      clarificationId,
      answers: Object.keys(answers).length > 0 ? answers : action.answers,
    };
  }
}
