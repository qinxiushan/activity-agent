// lib/plan-reducer.ts — 事件驱动状态转移（route-B 改动 1）
//
// 单一 reducer：所有相位转移收敛到 reduce() 纯函数，各处只 dispatch(event)、
// 不再直接调 transition()。合法性校验（isTransitionAllowed）由 dispatch() 兜底。
//
// 循环依赖说明：本文件只 `import type` plan-state 的类型（编译期擦除），
// 运行时无依赖；plan-state.ts 反向 import reduce（值）。故无运行时循环。

import { createHash } from "node:crypto";
import type { PlanPhase, PlanState, ProposedPlan } from "./plan-state";

// ─── 事件 ──────────────────────────────────────────────────────────

/** 用户这一轮消息的语义意图（由 LLM 结构化输出，取代正则 classifyUserConfirmation） */
export type Intent =
  | "new_request"   // 新请求
  | "smalltalk"     // 闲聊/问候/非活动规划，不激活工作流
  | "answer"        // 回答追问
  | "confirm"       // 确认方案
  | "modify"        // 修改方案
  | "reject"        // 推翻重来
  | "question"      // 提问（不改相位）
  | "cancel";       // 取消

export type PlanEvent =
  | { type: "USER_TURN_CLASSIFIED"; intent: Intent; planHash?: string }
  | { type: "INTENT_FIELDS_UPDATED"; missingCount: number }
  | { type: "CLARIFICATION_ASKED" }
  | { type: "CLARIFICATION_ANSWERED" }
  | { type: "PLAN_SUBMITTED"; plan: ProposedPlan }
  | { type: "USER_CONFIRMED"; planHash: string }
  | { type: "BOOKING_RESULT"; ok: boolean }
  | { type: "PLAN_SAVED" }
  | { type: "TIMEOUT" }
  | { type: "CANCEL" };

export interface ReduceOutput {
  phase: PlanPhase;
  plan?: ProposedPlan;
  /** 副作用标记，如 "warn_stale" / "reject_out_of_phase"，供上层做提示/审计 */
  effects: string[];
}

// ─── 方案指纹 ──────────────────────────────────────────────────────

/**
 * 计算方案指纹：只覆盖影响下单的关键字段（POI/时段/金额），
 * 排除展示文案——改文案不会让已展示的确认失效。
 */
export function hashOf(plan: ProposedPlan | null | undefined): string {
  if (!plan) return "";
  const actionable = {
    timeline: plan.timeline.map((t) => ({
      poiId: t.poiId ?? "",
      startTime: t.startTime,
      endTime: t.endTime,
      type: t.type,
    })),
    totalCost: plan.totalCost,
  };
  return createHash("sha256").update(JSON.stringify(actionable)).digest("hex").slice(0, 16);
}

// ─── reducer（唯一相位转移决策点，纯函数） ─────────────────────────

export function reduce(state: PlanState, event: PlanEvent): ReduceOutput {
  const phase = state.phase;
  const stay = (...effects: string[]): ReduceOutput => ({ phase, effects });
  const goto = (p: PlanPhase, plan?: ProposedPlan): ReduceOutput => ({ phase: p, plan, effects: [] });

  switch (event.type) {
    case "USER_TURN_CLASSIFIED": {
      const it = event.intent;
      if (it === "cancel") return goto("cancelled");
      if (it === "question" || it === "smalltalk") return stay(); // 提问/闲聊不改相位
      if (phase === "idle" || phase === "completed" || phase === "cancelled") {
        if (it === "new_request") return goto("intent_capture");
      } else if (phase === "clarifying") {
        if (it === "answer") return goto("intent_capture"); // 回去重判字段齐没齐
      } else if (phase === "plan_confirm") {
        if (it === "confirm") {
          if (event.planHash !== hashOf(state.plan)) return stay("warn_stale"); // ★ 版本不符
          return goto("executing");
        }
        if (it === "modify") return goto("planning");
        if (it === "reject") return goto("intent_capture");
      }
      return stay();
    }

    case "INTENT_FIELDS_UPDATED":
      return phase === "intent_capture" && event.missingCount === 0 ? goto("planning") : stay();

    case "CLARIFICATION_ASKED":
      return goto("clarifying");

    case "CLARIFICATION_ANSWERED":
      return phase === "clarifying" ? goto("planning") : stay("reject_out_of_phase");

    case "PLAN_SUBMITTED":
      return phase === "planning" ? goto("plan_confirm", event.plan) : stay("reject_out_of_phase");

    case "USER_CONFIRMED": // 前端确认按钮（结构化，独立于 LLM 文本通道）
      return phase === "plan_confirm" && event.planHash === hashOf(state.plan)
        ? goto("executing")
        : stay("reject");

    case "BOOKING_RESULT":
      return phase === "executing" ? goto(event.ok ? "completed" : "plan_confirm") : stay();

    case "PLAN_SAVED": // 方案保存 → 完成（当前完成路径；BOOKING_RESULT 为异步预订驱动的备用路径）
      return phase === "executing" ? goto("completed") : stay();

    case "TIMEOUT":
    case "CANCEL":
      return goto("cancelled");
  }

  return stay();
}
