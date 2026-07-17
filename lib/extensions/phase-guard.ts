import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getActivePlanState } from "../plan-state";

/**
 * Phase Gate Extension - SOP-v2 阶段守卫
 *
 * 通过 pi.on("tool_call") 钩子在工具执行前拦截非法调用，
 * 替代之前的 tool-wrapper beforeExecute 回调。
 *
 * - 在 LLM 决定调工具后立即拦截（早于 beforeExecute）
 * - 集中管理，不依赖每个工具单独 wrap
 * - 读取 AsyncLocalStorage 中的 PlanStateManager（与 tool execute 同异步上下文）
 *
 * Layer 1 of 3 (TOOL_PHASE_RULES 静态表 → Extension tool_call 钩子 → 工具 body 自检)
 */
export default function phaseGuardExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    // 只拦截自定义业务工具（intent_parse / get_weather / search_* / reservation_exec 等）
    // built-in 工具（read/write/bash）不拦截，因为它们不受 SOP 阶段管控
    const BUSINESS_TOOLS = new Set([
      "intent_parse",
      "ask_clarification",
      "get_weather",
      "search_activities",
      "search_restaurants",
      "check_opening_hours",
      "compute_route",
      "reservation_exec",
      "query_booking",
      "retry_booking",
      "plan_save",
      "plan_load",
    ]);

    if (!BUSINESS_TOOLS.has(event.toolName)) return; // 非业务工具放行

    const mgr = getActivePlanState();
    if (!mgr) return; // 没有 plan state（如初始化时）→ 放行

    const result = mgr.guardToolCall(event.toolName);
    if (!result.allowed) {
      return {
        block: true,
        reason: `Tool "${event.toolName}" is not allowed in phase "${result.currentPhase}". ` +
                `Current session is waiting for: ${mgr.currentPhase}.`,
      };
    }
  });
}
