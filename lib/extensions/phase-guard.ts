import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getActivePlanState } from "../plan-state";
import { sanitizeToolResult } from "../tool-result-sanitizer";
import { checkToolRateLimit } from "../rate-limiter";
import { audit } from "../audit-logger";

const BUSINESS_TOOLS = new Set([
  "classify_turn", "intent_parse", "submit_plan", "ask_clarification", "detect_user_region",
  "geocode", "reverse_geocode", "get_weather",
  "discover_place_candidates", "search_places_text", "search_places_nearby", "get_place_details",
  "search_activities", "search_restaurants",
  "check_opening_hours", "compute_route",
  "compare_route_options", "distance_matrix", "validate_itinerary",
  "calculate_budget",
  "commit_itinerary",
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
  const toolStartMeta = new Map<string, { at: number; userId: string | null; sessionId: string; argsSummary: string }>();

  // ── 阶段守卫 ───────────────────────────────────────────
  pi.on("tool_call", async (event) => {
    if (!BUSINESS_TOOLS.has(event.toolName)) return;
    const mgr = getActivePlanState();
    if (!mgr) return;
    const userId = mgr.userId ?? null;
    const sessionId = mgr.current.sessionId;
    const args = (event as { input?: unknown; args?: unknown }).input ?? (event as { args?: unknown }).args;
    const argsSummary = summarizeAuditDetail(args);

    const result = mgr.guardToolCall(event.toolName);
    if (!result.allowed) {
      audit({
        userId,
        sessionId,
        eventType: "tool_blocked",
        toolName: event.toolName,
        detail: {
          currentPhase: result.currentPhase,
          reason: result.error,
        },
      });
      return {
        block: true,
        reason: `Tool "${event.toolName}" is not allowed in phase "${result.currentPhase}".`,
      };
    }

    if (userId) {
      const verdict = await checkToolRateLimit(userId, event.toolName);
      if (verdict && !verdict.allowed) {
        audit({
          userId,
          sessionId,
          eventType: "rate_limited",
          toolName: event.toolName,
          detail: {
            action: `tool:${event.toolName}`,
            retryAfterMs: verdict.retryAfterMs,
            limit: verdict.limit,
          },
        });
        return {
          block: true,
          reason: `Tool "${event.toolName}" is rate limited. Retry after ${Math.ceil(verdict.retryAfterMs / 1000)}s.`,
        };
      }
    }

    toolStartMeta.set(event.toolCallId, {
      at: Date.now(),
      userId,
      sessionId,
      argsSummary,
    });
  });

  // ── 工具结果脱敏（T5）─────────────────────────────────
  pi.on("tool_result", async (event) => {
    if (!BUSINESS_TOOLS.has(event.toolName)) return;
    const started = toolStartMeta.get(event.toolCallId);
    toolStartMeta.delete(event.toolCallId);
    if (started) {
      audit({
        userId: started.userId,
        sessionId: started.sessionId,
        eventType: "tool_call",
        toolName: event.toolName,
        detail: {
          args: started.argsSummary,
          durationMs: Math.max(0, Date.now() - started.at),
          isError: event.isError === true,
        },
      });
    }
    if (!Array.isArray(event.content)) return;
    if (event.isError) return;

    let modified = false;
    const newContent = event.content.map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      const { sanitized, truncated, reason, keyword } = sanitizeToolResult(event.toolName, block.text);
      if (truncated || reason) modified = true;
      if (reason === "prompt_injection_detected") {
        audit({
          userId: started?.userId ?? null,
          sessionId: started?.sessionId ?? null,
          eventType: "injection_detected",
          toolName: event.toolName,
          detail: {
            source: "tool_result",
            keyword: keyword ?? "unknown",
          },
        });
      }
      return { type: "text" as const, text: sanitized };
    });

    if (modified) return { content: newContent };
  });
}

function summarizeAuditDetail(value: unknown, max = 500): string {
  if (value === undefined || value === null) return "";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? text.slice(0, max) + "…" : text;
  } catch {
    return String(value).slice(0, max);
  }
}
