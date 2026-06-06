"use client";

import { PhaseProgress } from "./PhaseProgress";
import { PlanTimeline } from "./PlanTimeline";
import { ToolTimeline } from "./ToolTimeline";
import { BookingCard } from "./BookingCard";
import type { ActivityPlanState, ActivityToolCall } from "@/hooks/useActivitySession";

export function ActivityPanel({
  planState,
  toolCalls,
}: {
  planState: ActivityPlanState | null;
  toolCalls: ActivityToolCall[];
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <PhaseProgress planState={planState} />
      <BookingCard toolCalls={toolCalls} planState={planState} />
      <PlanTimeline planState={planState} />
      <ToolTimeline toolCalls={toolCalls} />
    </div>
  );
}
