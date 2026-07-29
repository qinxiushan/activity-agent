import { randomUUID } from "node:crypto";
import type {
  EvalRun,
  EvalStateSnapshot,
  EvalTarget,
  EvalTraceEvent,
} from "./types";

export class EvalTraceRecorder {
  private readonly events: EvalTraceEvent[] = [];
  private readonly startedAt = new Date();
  private finalState?: EvalStateSnapshot;

  constructor(
    readonly scenarioId: string,
    readonly scenarioVersion: string,
    readonly target: EvalTarget,
    readonly runId = `eval_${randomUUID()}`,
  ) {}

  append(event: Omit<EvalTraceEvent, "sequence">): EvalTraceEvent {
    const recorded = {
      ...event,
      sequence: this.events.length + 1,
    } satisfies EvalTraceEvent;
    this.events.push(recorded);
    return recorded;
  }

  appendMany(events: Omit<EvalTraceEvent, "sequence">[]): void {
    for (const event of events) this.append(event);
  }

  snapshot(state: EvalStateSnapshot): void {
    this.finalState = structuredClone(state);
    this.append({
      at: new Date().toISOString(),
      type: "state_snapshot",
      phase: state.phase,
      detail: {
        turnCount: state.turnCount,
        clarificationCount: state.clarificationCount,
      },
    });
  }

  get trace(): readonly EvalTraceEvent[] {
    return this.events;
  }

  build(): EvalRun {
    const endedAt = new Date();
    return {
      runId: this.runId,
      scenarioId: this.scenarioId,
      scenarioVersion: this.scenarioVersion,
      target: this.target,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      events: structuredClone(this.events),
      finalState: this.finalState ? structuredClone(this.finalState) : undefined,
      metrics: {
        durationMs: endedAt.getTime() - this.startedAt.getTime(),
        toolCallCount: this.events.filter((event) => event.type === "tool_end").length,
        errorCount: this.events.filter((event) =>
          event.type === "error" || (event.type === "tool_end" && event.ok === false)).length,
      },
    };
  }
}
