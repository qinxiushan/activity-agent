import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getActivePlanState } from "../plan-state";
import { sanitizeToolResult } from "../tool-result-sanitizer";

const BUSINESS_TOOLS = new Set([
  "intent_parse", "ask_clarification",
  "get_weather", "search_activities", "search_restaurants",
  "check_opening_hours", "compute_route",
  "reservation_exec", "query_booking", "retry_booking",
  "plan_save", "plan_load",
]);

/**
 * Phase Gate Extension
 *
 * Layer 1: TOOL_PHASE_RULES 静态表 (plan-state.ts)
 * Layer 2: Extension tool_call 钩子 (此文件)
 * Layer 3: 工具 body 自检 (activity-tools.ts)
 */
export default function phaseGuardExtension(pi: ExtensionAPI): void {
  // ── 阶段守卫 ───────────────────────────────────────────
  pi.on("tool_call", async (event) => {
    if (!BUSINESS_TOOLS.has(event.toolName)) return;
    const mgr = getActivePlanState();
    if (!mgr) return;

    const result = mgr.guardToolCall(event.toolName);
    if (!result.allowed) {
      return {
        block: true,
        reason: `Tool "${event.toolName}" is not allowed in phase "${result.currentPhase}".`,
      };
    }
  });

  // ── 工具结果脱敏（T5）─────────────────────────────────
  pi.on("tool_result", async (event) => {
    if (!BUSINESS_TOOLS.has(event.toolName)) return;
    if (event.isError) return;
    if (!Array.isArray(event.content)) return;

    let modified = false;
    const newContent = event.content.map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      const { sanitized, truncated, reason } = sanitizeToolResult(event.toolName, block.text);
      if (truncated || reason) modified = true;
      return { type: "text" as const, text: sanitized };
    });

    if (modified) return { content: newContent };
  });
}
