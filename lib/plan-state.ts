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
  departurePoint?: { name: string; lng: number; lat: number; city: string };
  partySize?: number;
  groupType?: "single" | "couple" | "friends" | "family";
  budgetPerPerson?: number;
  preferredCategories?: string[];
  dietaryRestrictions?: string[];
  mood?: string;
  specialRequests?: string[];
}

export interface ProposedPlan {
  summary: string;
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
  phase: PlanPhase;
  turnCount: number;
  clarificationCount: number;
  intent: CapturedIntent;
  plan: ProposedPlan | null;
  lastTransitionAt: number;
  history: Array<{ phase: PlanPhase; at: number; reason?: string }>;
}

// ─── 工具-phase 规则 ───────────────────────────────────────────────

export const TOOL_PHASE_RULES: Record<string, PlanPhase[]> = {
  intent_parse: ["intent_capture", "clarifying", "planning"],
  ask_clarification: ["intent_capture"],
  get_weather: ["intent_capture", "planning"],
  search_activities: ["planning"],
  search_restaurants: ["planning"],
  check_opening_hours: ["planning"],
  compute_route: ["planning"],
  reservation_exec: ["executing"],
  query_booking: ["plan_confirm", "executing", "completed"],
  retry_booking: ["executing"],
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
  constructor(sessionId: string, _storageDir?: string) {
    this.state = {
      sessionId,
      phase: "idle",
      turnCount: 0,
      clarificationCount: 0,
      intent: {},
      plan: null,
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

  get intent(): CapturedIntent {
    return this.state.intent;
  }

  get plan(): ProposedPlan | null {
    return this.state.plan;
  }

  get clarificationCount(): number {
    return this.state.clarificationCount;
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
    this.state.lastTransitionAt = Date.now();
    this.state.history.push({ phase: to, at: Date.now(), reason: reason ?? `from ${from}` });
    await this.persist();
    return { ok: true };
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

  reset(): void {
    this.state.phase = "idle";
    this.state.turnCount = 0;
    this.state.clarificationCount = 0;
    this.state.intent = {};
    this.state.plan = null;
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

  static async load(sessionId: string, _storageDir?: string): Promise<PlanStateManager> {
    const mgr = new PlanStateManager(sessionId);
    const data = await getPlanStateRepo().load(sessionId);
    if (data) Object.assign(mgr.state, data);
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
    executing: "正在执行预订",
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


