/**
 * Plan State Machine - 单次确认 + 单次追问的硬约束
 *
 * 真实 SOP（用户新设计）：
 *   1. 用户输入 → intent_capture（结构化提取）
 *   2. 关键字段缺失？→ 追问 1 次（clarifying）→ 必须用默认值推进
 *   3. planning（自动）：LLM 调 weather/POI/route/opening-hours 工具，无需用户
 *   4. plan_confirm 唯一用户确认点（确认/修改/重新生成）
 *   5. executing（真实预订）
 *   6. completed
 *
 * 设计：
 * - 显式状态机 + 工具调用前 phase 校验
 * - 追问次数硬限 1（clarificationCount）
 * - 持久化：~/.pi/agent/plan-states/<sessionId>.json
 * - 跨 session 隔离：每个 session 独立的 PlanStateManager
 * - 无全局单例：PlanStateManager 通过闭包注入到每个 session 的工具中
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getPlanStateRepo } from "./storage";
import { reduce, type PlanEvent, type ReduceOutput } from "./plan-reducer";
import type { BudgetBreakdown } from "./budget-service";
import {
  applyClarificationAnswers,
  type PendingClarification,
} from "./clarification";

// ─── 类型定义 ──────────────────────────────────────────────────────

export type PlanPhase =
  | "idle"
  | "intent_capture"
  | "clarifying"
  | "planning"
  | "plan_confirm"
  | "executing"
  | "completed"
  | "cancelled";

export type CriticalField = "date" | "startTime" | "partySize" | "departurePoint" | "budgetPerPerson";

export interface CapturedIntent {
  date?: string;
  startTime?: string;
  endTime?: string;
  departurePoint?: { name: string; city: string; lng?: number; lat?: number };
  partySize?: number;
  groupType?: "single" | "couple" | "friends" | "family";
  budgetPerPerson?: number;
  preferredCategories?: string[];
  dietaryRestrictions?: string[];
  mood?: string;
  specialRequests?: string[];
  endPolicy?: "last_poi" | "return_to_start" | "specified";
  endPoint?: { name: string; city?: string; lng?: number; lat?: number };
  transportPreferences?: Array<"walking" | "transit" | "driving" | "bicycling">;
}

export interface ProposedPlan {
  summary: string;
  validationToken?: string;
  budgetToken?: string;
  budgetBreakdown?: BudgetBreakdown;
  timeline: Array<{
    startTime: string;
    endTime: string;
    type: "departure" | "transit" | "activity" | "meal" | "rest";
    poiId?: string;
    poiName?: string;
    notes?: string;
  }>;
  totalCost: number;
  totalDurationMinutes: number;
  weather: { city: string; date: string; condition: string; tempMax: number; tempMin: number; advice: string };
}

export interface PlanState {
  sessionId: string;
  userId?: string;
  phase: PlanPhase;
  turnCount: number;
  clarificationCount: number;
  intent: CapturedIntent;
  plan: ProposedPlan | null;
  /** POIs that have appeared in submitted plans in this session. */
  recommendedPoiIds?: string[];
  lastItineraryValidation?: {
    token: string;
    valid: boolean;
    timelineJson: string;
    at: number;
  };
  lastBudgetCalculation?: {
    token: string;
    breakdownJson: string;
    at: number;
  };
  pendingClarification?: PendingClarification;
  lastTransitionAt: number;
  history: Array<{ phase: PlanPhase; at: number; reason?: string }>;
}

export interface PlanRuntimeContext {
  /** Runtime-only. Never persisted or returned to the model. */
  clientIp?: string;
}

export type CanonicalPlanningArtifacts =
  | {
      ok: true;
      timeline: ProposedPlan["timeline"];
      budgetBreakdown: BudgetBreakdown;
    }
  | {
      ok: false;
      code: "ITINERARY_TOKEN_INVALID" | "BUDGET_TOKEN_INVALID" | "PLANNING_ARTIFACT_CORRUPTED";
      message: string;
    };

// ─── 工具-phase 规则 ───────────────────────────────────────────────

export const TOOL_PHASE_RULES: Record<string, PlanPhase[]> = {
  classify_turn: ["clarifying", "plan_confirm"],
  intent_parse: ["intent_capture", "clarifying", "planning"],
  submit_plan: ["planning"],
  ask_clarification: ["intent_capture"],
  detect_user_region: ["intent_capture", "planning"],
  geocode: ["planning"],
  reverse_geocode: ["planning"],
  get_weather: ["intent_capture", "planning"],
  discover_place_candidates: ["planning"],
  search_places_text: ["planning"],
  search_places_nearby: ["planning"],
  get_place_details: ["planning", "plan_confirm"],
  search_activities: ["planning"],
  search_restaurants: ["planning"],
  check_opening_hours: ["planning"],
  compute_route: ["planning"],
  compare_route_options: ["planning"],
  distance_matrix: ["planning"],
  validate_itinerary: ["planning"],
  calculate_budget: ["planning"],
  commit_itinerary: ["executing"],
  plan_save: ["executing", "completed"],
  plan_load: ["idle", "intent_capture"],
};

export const PHASE_TRANSITIONS: Record<PlanPhase, PlanPhase[]> = {
  idle: ["intent_capture", "cancelled"],
  intent_capture: ["clarifying", "planning", "cancelled"],
  clarifying: ["planning", "cancelled"],
  planning: ["plan_confirm", "intent_capture", "cancelled"],
  plan_confirm: ["executing", "planning", "intent_capture", "cancelled"],
  executing: ["completed", "plan_confirm", "cancelled"],
  completed: ["intent_capture"],
  cancelled: ["intent_capture"],
};

// ─── 校验函数 ──────────────────────────────────────────────────────

export function isToolAllowedInPhase(toolName: string, phase: PlanPhase): boolean {
  const allowed = TOOL_PHASE_RULES[toolName];
  if (!allowed) return true;
  return allowed.includes(phase);
}

export function isTransitionAllowed(from: PlanPhase, to: PlanPhase): boolean {
  return PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

export const CRITICAL_FIELDS: CriticalField[] = ["date", "startTime", "partySize", "departurePoint", "budgetPerPerson"];

export function getMissingCriticalFields(intent: CapturedIntent): CriticalField[] {
  const missing: CriticalField[] = [];
  if (!intent.date) missing.push("date");
  if (!intent.startTime) missing.push("startTime");
  if (intent.partySize === undefined) missing.push("partySize");
  if (!intent.departurePoint) missing.push("departurePoint");
  if (intent.budgetPerPerson === undefined) missing.push("budgetPerPerson");
  return missing;
}

export const MAX_CLARIFICATIONS = 1;

// ─── PlanStateManager ──────────────────────────────────────────────

export class PlanStateManager {
  private readonly state: PlanState;
  private runtimeContext: PlanRuntimeContext;
  constructor(sessionId: string, _storageDir?: string, userId?: string, runtimeContext: PlanRuntimeContext = {}) {
    this.runtimeContext = runtimeContext;
    this.state = {
      sessionId,
      userId,
      phase: "idle",
      turnCount: 0,
      clarificationCount: 0,
      intent: {},
      plan: null,
      recommendedPoiIds: [],
      lastTransitionAt: Date.now(),
      history: [{ phase: "idle", at: Date.now() }],
    };
  }

  get current(): PlanState {
    return this.state;
  }

  get currentPhase(): PlanPhase {
    return this.state.phase;
  }

  get userId(): string | undefined {
    return this.state.userId;
  }

  get intent(): CapturedIntent {
    return this.state.intent;
  }

  get plan(): ProposedPlan | null {
    return this.state.plan;
  }

  get recommendedPoiIds(): string[] {
    return [...(this.state.recommendedPoiIds ?? [])];
  }

  candidateExclusions(extra: string[] = []): string[] {
    const currentPlanIds = this.state.plan?.timeline.flatMap((entry) =>
      entry.poiId && (entry.type === "activity" || entry.type === "meal") ? [entry.poiId] : []) ?? [];
    return [...new Set([...(this.state.recommendedPoiIds ?? []), ...currentPlanIds, ...extra])];
  }

  get clarificationCount(): number {
    return this.state.clarificationCount;
  }

  get pendingClarification(): PendingClarification | undefined {
    return this.state.pendingClarification;
  }

  recordPendingClarification(clarification: PendingClarification): void {
    this.state.pendingClarification = clarification;
  }

  async answerClarification(
    clarificationId: string,
    answers: Record<string, unknown>,
  ): Promise<{ ok: true; phase: PlanPhase; intent: CapturedIntent } | { ok: false; error: string }> {
    const pending = this.state.pendingClarification;
    if (this.state.phase !== "clarifying") {
      return { ok: false, error: "当前不在追问阶段" };
    }
    if (!pending || pending.id !== clarificationId) {
      return { ok: false, error: "追问卡片已过期，请刷新后重试" };
    }
    try {
      const applied = applyClarificationAnswers(pending, answers);
      const nextIntent = { ...this.state.intent, ...applied.intent };
      const missing = getMissingCriticalFields(nextIntent);
      if (missing.length > 0) {
        return { ok: false, error: `仍缺少必填字段: ${missing.join(", ")}` };
      }
      this.state.intent = nextIntent;
      this.state.pendingClarification = {
        ...pending,
        status: "answered",
        answers: applied.normalizedAnswers,
        answeredAt: Date.now(),
      };
      const out = await this.dispatch({ type: "CLARIFICATION_ANSWERED" });
      if (out.phase !== "planning") {
        return { ok: false, error: `追问提交后未进入 planning（当前 ${out.phase}）` };
      }
      return { ok: true, phase: out.phase, intent: this.state.intent };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async recordItineraryValidation(token: string, valid: boolean, timeline: ProposedPlan["timeline"]): Promise<void> {
    this.state.lastItineraryValidation = {
      token,
      valid,
      timelineJson: JSON.stringify(timeline),
      at: Date.now(),
    };
    await this.persist();
  }

  verifyItineraryValidation(token: string | undefined, timeline: ProposedPlan["timeline"]): boolean {
    const validation = this.state.lastItineraryValidation;
    return !!validation?.valid && !!token && validation.token === token &&
      validation.timelineJson === JSON.stringify(timeline);
  }

  async recordBudgetCalculation(token: string, breakdown: BudgetBreakdown): Promise<void> {
    this.state.lastBudgetCalculation = {
      token,
      breakdownJson: JSON.stringify(breakdown),
      at: Date.now(),
    };
    await this.persist();
  }

  verifyBudgetCalculation(
    token: string | undefined,
    breakdown: BudgetBreakdown | undefined,
    totalCost: number | undefined,
  ): boolean {
    const calculation = this.state.lastBudgetCalculation;
    return !!calculation && !!token && !!breakdown &&
      calculation.token === token &&
      calculation.breakdownJson === JSON.stringify(breakdown) &&
      totalCost === breakdown.projectedTotal;
  }

  /**
   * Resolve server-owned planning artifacts by opaque handles.
   *
   * The LLM must not echo timeline/budget JSON back to the server: generative
   * reserialization can change harmless whitespace or display notes and cause
   * false mismatches. Tokens select the exact canonical outputs persisted by
   * validate_itinerary and calculate_budget.
   */
  resolvePlanningArtifacts(
    validationToken: string,
    budgetToken: string,
  ): CanonicalPlanningArtifacts {
    const validation = this.state.lastItineraryValidation;
    if (!validation?.valid || validation.token !== validationToken) {
      return {
        ok: false,
        code: "ITINERARY_TOKEN_INVALID",
        message: "validationToken 无效或已过期，请重新调用 validate_itinerary。",
      };
    }
    const calculation = this.state.lastBudgetCalculation;
    if (!calculation || calculation.token !== budgetToken) {
      return {
        ok: false,
        code: "BUDGET_TOKEN_INVALID",
        message: "budgetToken 无效或已过期，请重新调用 calculate_budget。",
      };
    }
    try {
      const timeline = JSON.parse(validation.timelineJson) as unknown;
      const budgetBreakdown = JSON.parse(calculation.breakdownJson) as unknown;
      if (!Array.isArray(timeline) ||
          !budgetBreakdown || typeof budgetBreakdown !== "object" ||
          typeof (budgetBreakdown as { projectedTotal?: unknown }).projectedTotal !== "number") {
        throw new Error("invalid artifact shape");
      }
      return {
        ok: true,
        timeline: timeline as ProposedPlan["timeline"],
        budgetBreakdown: budgetBreakdown as BudgetBreakdown,
      };
    } catch {
      return {
        ok: false,
        code: "PLANNING_ARTIFACT_CORRUPTED",
        message: "服务端规划产物损坏，请重新运行行程校验和预算计算。",
      };
    }
  }

  get clientIp(): string | undefined {
    return this.runtimeContext.clientIp;
  }

  updateRuntimeContext(context: PlanRuntimeContext): void {
    if (context.clientIp) this.runtimeContext = { ...this.runtimeContext, clientIp: context.clientIp };
  }

  async transition(to: PlanPhase, reason?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.state.phase === to) return { ok: true };
    if (!isTransitionAllowed(this.state.phase, to)) {
      return {
        ok: false,
        error: `Illegal phase transition: ${this.state.phase} → ${to}. Allowed: [${PHASE_TRANSITIONS[this.state.phase].join(", ")}]`,
      };
    }
    const from = this.state.phase;
    this.state.phase = to;
    if (to === "planning" && from !== "planning") {
      this.state.lastItineraryValidation = undefined;
      this.state.lastBudgetCalculation = undefined;
    }
    this.state.lastTransitionAt = Date.now();
    this.state.history.push({ phase: to, at: Date.now(), reason: reason ?? `from ${from}` });
    await this.persist();
    return { ok: true };
  }

  /**
   * 事件驱动的相位转移（route-B）：唯一入口，各处只 dispatch(event)。
   * reduce() 决定下一相位，isTransitionAllowed 兜底拦非法转移，仅在变化时持久化。
   */
  async dispatch(event: PlanEvent): Promise<ReduceOutput> {
    const out = reduce(this.state, event);
    let changed = false;

    if (out.phase !== this.state.phase) {
      if (!isTransitionAllowed(this.state.phase, out.phase)) {
        return { phase: this.state.phase, effects: [...out.effects, "illegal_transition"] };
      }
      const from = this.state.phase;
      this.state.phase = out.phase;
      if (out.phase === "planning" && from !== "planning") {
        this.state.lastItineraryValidation = undefined;
        this.state.lastBudgetCalculation = undefined;
      }
      this.state.lastTransitionAt = Date.now();
      this.state.history.push({ phase: out.phase, at: Date.now(), reason: `event:${event.type} (from ${from})` });
      changed = true;
    }

    if (out.plan && out.plan !== this.state.plan) {
      this.state.plan = out.plan;
      const selectedPoiIds = out.plan.timeline.flatMap((entry) =>
        entry.poiId && (entry.type === "activity" || entry.type === "meal") ? [entry.poiId] : []);
      this.state.recommendedPoiIds = [...new Set([
        ...(this.state.recommendedPoiIds ?? []),
        ...selectedPoiIds,
      ])];
      changed = true;
    }

    if (changed) await this.persist();
    return out;
  }

  recordIntent(intent: Partial<CapturedIntent>): void {
    this.state.intent = { ...this.state.intent, ...intent };
  }

  recordPlan(plan: ProposedPlan): void {
    this.state.plan = plan;
  }

  incrementClarification(): boolean {
    if (this.state.clarificationCount >= MAX_CLARIFICATIONS) return false;
    this.state.clarificationCount++;
    return true;
  }

  guardToolCall(toolName: string): { allowed: true } | { allowed: false; error: string; currentPhase: PlanPhase } {
    if (!isToolAllowedInPhase(toolName, this.state.phase)) {
      return {
        allowed: false,
        error: `Tool "${toolName}" is not allowed in phase "${this.state.phase}". ` +
               `Allowed phases: [${TOOL_PHASE_RULES[toolName]?.join(", ") ?? "any"}]. ` +
               `Current session is: ${describeWaitingFor(this.state.phase)}.`,
        currentPhase: this.state.phase,
      };
    }
    return { allowed: true };
  }

  incrementTurn(): void {
    this.state.turnCount++;
  }

  async setUserId(userId: string): Promise<void> {
    if (!userId || this.state.userId === userId) return;
    this.state.userId = userId;
    await this.persist();
  }

  reset(): void {
    this.state.phase = "idle";
    this.state.turnCount = 0;
    this.state.clarificationCount = 0;
    this.state.intent = {};
    this.state.plan = null;
    this.state.recommendedPoiIds = [];
    this.state.lastItineraryValidation = undefined;
    this.state.lastBudgetCalculation = undefined;
    this.state.pendingClarification = undefined;
    this.state.history.push({ phase: "idle", at: Date.now(), reason: "reset" });
  }

  private async persist(): Promise<void> {
    try {
      await getPlanStateRepo().save(this.state);
    } catch (e) {
      console.error(`[PlanStateManager] persist failed:`, e);
      throw e;
    }
  }

  static async load(sessionId: string, _storageDir?: string, userId?: string, runtimeContext: PlanRuntimeContext = {}): Promise<PlanStateManager> {
    const mgr = new PlanStateManager(sessionId, undefined, userId, runtimeContext);
    const data = await getPlanStateRepo().load(sessionId);
    if (data) Object.assign(mgr.state, data);
    if (!Array.isArray(mgr.state.recommendedPoiIds)) mgr.state.recommendedPoiIds = [];
    if (!mgr.state.userId && userId) {
      mgr.state.userId = userId;
    }
    return mgr;
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────────────

export function describeWaitingFor(phase: PlanPhase): string {
  const descriptions: Record<PlanPhase, string> = {
    idle: "等待用户输入",
    intent_capture: "正在分析用户意图",
    clarifying: "等待用户回答追问（最多 1 次）",
    planning: "正在自动生成方案（无需用户操作）",
    plan_confirm: "等待用户对最终方案确认（确认/修改/重新生成）",
    executing: "正在生成行程",
    completed: "已完成",
    cancelled: "已取消",
  };
  return descriptions[phase] ?? phase;
}

// ─── AsyncLocalStorage 上下文 ─────────────────────────────────────
// 替代全局单例 _activePlanState。
// 每个 session 的 prompt 调用链通过计划状态存储获得自己的 PlanStateManager 作用域，
// 工具 execute 函数通过 getActivePlanState() 读取当前异步链的 PlanStateManager。

const planStateStorage = new AsyncLocalStorage<PlanStateManager>();

/**
 * 在指定的 PlanStateManager 作用域内执行异步函数。
 * 供 AgentSessionWrapper.send() 在 prompt 前调用。
 */
export function withPlanState<T>(mgr: PlanStateManager, fn: () => Promise<T>): Promise<T> {
  return planStateStorage.run(mgr, fn);
}

/**
 * 获取当前异步链绑定的 PlanStateManager。
 * 供工具 execute 函数在 wrapper beforeExecute 和体内部读取。
 */
export function getActivePlanState(): PlanStateManager | null {
  return planStateStorage.getStore() ?? null;
}

export function classifyUserConfirmation(message: string): "confirm" | "reject" | "modify" | "ambiguous" {
  const m = message.trim().toLowerCase();
  if (/^(确认|好的|可以|没问题|对|yes|ok|确认预订|确认方案|就这个|就这个吧|同意|就它了|安排)/i.test(m)) return "confirm";
  if (/^(不要|不行|拒绝|cancel|取消|不对|错误|全部取消|放弃)/i.test(m)) return "reject";
  if (/(修改|换一下|调整|改|重新|换成|不要这个|不要那个|再加|去掉|增加|减少|把.+换|换个)/i.test(m)) return "modify";
  return "ambiguous";
}
