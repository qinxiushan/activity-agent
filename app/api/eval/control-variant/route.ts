import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getWorkflowControlDescriptor } from "@/lib/workflow-control/config";
import { ACTIVITY_PLANNER_SYSTEM_PROMPT } from "@/src/prompts/activity-planner";
import { getActivityPlannerTools } from "@/src/tools/activity-tools";

function digest(value: unknown): string {
  return createHash("sha256").update(
    typeof value === "string" ? value : JSON.stringify(value),
  ).digest("hex").slice(0, 16);
}

export async function GET() {
  const tools = getActivityPlannerTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    executionMode: tool.executionMode,
  }));
  return NextResponse.json({
    ...getWorkflowControlDescriptor(),
    promptHash: digest(ACTIVITY_PLANNER_SYSTEM_PROMPT),
    toolContractHash: digest(tools),
  });
}
