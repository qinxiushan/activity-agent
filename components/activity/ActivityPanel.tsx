"use client";

import { PhaseProgress } from "./PhaseProgress";
import { PlanTimeline } from "./PlanTimeline";
import { ToolTimeline } from "./ToolTimeline";
import { BookingCard } from "./BookingCard";
import type { ActivityPlanState, ActivityToolCall } from "@/hooks/useActivitySession";

const PLAN_VISIBLE_PHASES = new Set(["plan_confirm", "executing", "completed"]);
const TOOL_VISIBLE_PHASES = new Set([
  "intent_capture", "clarifying", "planning", "plan_confirm", "executing", "completed",
]);

function hasBooking(toolCalls: ActivityToolCall[]): boolean {
  return toolCalls.some(
    (tc) => (tc.name === "reservation_exec" || tc.name === "query_booking") && tc.ok && tc.endedAt !== null,
  );
}

export function ActivityPanel({
  planState,
  toolCalls,
}: {
  planState: ActivityPlanState | null;
  toolCalls: ActivityToolCall[];
}) {
  const phase = planState?.phase ?? "idle";
  const showPlan = PLAN_VISIBLE_PHASES.has(phase);
  const showTools = TOOL_VISIBLE_PHASES.has(phase);
  const showBooking = hasBooking(toolCalls);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <PhaseProgress planState={planState} />
      {showBooking && <BookingCard toolCalls={toolCalls} planState={planState} />}
      {showPlan && <PlanTimeline planState={planState} />}
      {showTools && <ToolTimeline toolCalls={toolCalls} />}
    </div>
  );
}
