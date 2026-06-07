/**
 * User Preferences Store - 跨 session 记忆用户偏好
 *
 * 设计：
 * - 每个用户一个 JSON 文件：~/.pi/agent/user-profiles/<userId>.json
 * - "defaults" 字段是从历史推断的稳定默认值（出发地/人数/预算/偏好类目等）
 *   缺失关键字段时 intent_parse 会用它自动填充（并标记 autoFilled）
 * - "stats" 是历史统计（总 session/订单数、最常去的餐厅/活动类型、平均预算）
 * - "recentSessions" 是最近 5 个完成的方案（用于 "上次你..." 回忆）
 *
 * 触发点：
 * - intent_parse 完成后 → 用 prefs 填充缺失关键字段
 * - phase → completed 时 → recordCompletedSession 写入 recent + 更新 stats
 * - 用户点 "从历史重新学习" → refreshFromHistory() 全量重导
 *
 * v1：单用户 ("default")，与 BookingOrder.userId 硬编码保持一致。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CapturedIntent, PlanState } from "./plan-state";
import { getBookingService } from "./booking-service";

export const DEFAULT_USER_ID = "default";
const STORAGE_DIR = path.join(os.homedir(), ".pi", "agent", "user-profiles");
const RECENT_SESSIONS_MAX = 5;
// A field becomes a "default" only if it appears in >= this fraction of past sessions
const DEFAULT_THRESHOLD = 0.5;

// ─── 类型 ───────────────────────────────────────────────────────────

export interface UserDeparturePoint {
  name: string;
  city: string;
  lng: number;
  lat: number;
}

export interface UserPreferencesDefaults {
  departurePoint?: UserDeparturePoint;
  partySize?: number;
  groupType?: CapturedIntent["groupType"];
  budgetPerPerson?: number;
  preferredCategories?: string[];
  dietaryRestrictions?: string[];
  mood?: string;
}

export interface UserPreferencesStats {
  totalSessions: number;
  totalBookings: number;
  totalCompletedPlans: number;
  favoriteRestaurants: Array<{ name: string; count: number; lastBookedAt: number }>;
  favoriteCategories: Array<{ category: string; count: number }>;
  averageBudget: number;
}

export interface UserPreferencesRecentSession {
  sessionId: string;
  date: number;
  summary: string;
  intent: Partial<CapturedIntent>;
}

export interface UserPreferences {
  userId: string;
  updatedAt: number;
  defaults: UserPreferencesDefaults;
  stats: UserPreferencesStats;
  recentSessions: UserPreferencesRecentSession[];
}

// Critical fields that can be auto-filled (mirrors plan-state.ts CRITICAL_FIELDS)
export const AUTO_FILL_FIELDS = [
  "date",
  "startTime",
  "partySize",
  "departurePoint",
  "budgetPerPerson",
] as const;
export type AutoFillField = (typeof AUTO_FILL_FIELDS)[number];

// ─── UserPreferencesStore ───────────────────────────────────────────

export class UserPreferencesStore {
  readonly userId: string;
  private readonly storageDir: string;
  private cache: UserPreferences | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(userId: string = DEFAULT_USER_ID, storageDir?: string) {
    this.userId = userId;
    this.storageDir = storageDir ?? STORAGE_DIR;
  }

  // ─── I/O ────────────────────────────────────────────────────

  private async ensureInit(): Promise<void> {
    if (this.cache) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await fs.mkdir(this.storageDir, { recursive: true });
        const file = path.join(this.storageDir, `${this.userId}.json`);
        try {
          const content = await fs.readFile(file, "utf-8");
          this.cache = JSON.parse(content) as UserPreferences;
        } catch {
          this.cache = this.empty();
        }
      })();
    }
    return this.initPromise;
  }

  private empty(): UserPreferences {
    return {
      userId: this.userId,
      updatedAt: Date.now(),
      defaults: {},
      stats: {
        totalSessions: 0,
        totalBookings: 0,
        totalCompletedPlans: 0,
        favoriteRestaurants: [],
        favoriteCategories: [],
        averageBudget: 0,
      },
      recentSessions: [],
    };
  }

  async load(): Promise<UserPreferences> {
    await this.ensureInit();
    return this.cache!;
  }

  async save(prefs: UserPreferences): Promise<void> {
    await this.ensureInit();
    prefs.updatedAt = Date.now();
    this.cache = prefs;
    const file = path.join(this.storageDir, `${this.userId}.json`);
    await fs.writeFile(file, JSON.stringify(prefs, null, 2), "utf-8");
  }

  async reset(): Promise<void> {
    await this.save(this.empty());
  }

  // ─── 字段更新 ────────────────────────────────────────────────

  async updateDefaults(updates: Partial<UserPreferencesDefaults>): Promise<UserPreferences> {
    const prefs = await this.load();
    prefs.defaults = { ...prefs.defaults, ...updates };
    // Strip undefined keys
    for (const k of Object.keys(prefs.defaults) as (keyof UserPreferencesDefaults)[]) {
      if (prefs.defaults[k] === undefined) delete prefs.defaults[k];
    }
    await this.save(prefs);
    return prefs;
  }

  async clearDefault(field: keyof UserPreferencesDefaults): Promise<UserPreferences> {
    const prefs = await this.load();
    delete prefs.defaults[field];
    await this.save(prefs);
    return prefs;
  }

  // ─── Auto-fill (called from intent_parse) ─────────────────────

  /**
   * Return a partial intent with critical fields filled in from defaults.
   * Also returns the list of fields that were auto-filled (for UI marking).
   */
  async autoFillIntent(currentIntent: Partial<CapturedIntent>): Promise<{
    filled: Partial<CapturedIntent>;
    autoFilledFields: AutoFillField[];
  }> {
    const prefs = await this.load();
    const filled: Partial<CapturedIntent> = { ...currentIntent };
    const autoFilledFields: AutoFillField[] = [];

    for (const field of AUTO_FILL_FIELDS) {
      if (filled[field] === undefined || filled[field] === null) {
        const defaultValue = (prefs.defaults as Record<string, unknown>)[field];
        if (defaultValue !== undefined) {
          (filled as Record<string, unknown>)[field] = defaultValue;
          autoFilledFields.push(field);
        }
      }
    }

    return { filled, autoFilledFields };
  }

  // ─── 记录完成的 session ──────────────────────────────────────

  async recordCompletedSession(planState: PlanState): Promise<void> {
    const prefs = await this.load();

    // Only count sessions that actually captured intent
    if (Object.keys(planState.intent).length > 0) {
      // De-dupe by sessionId
      prefs.recentSessions = [
        {
          sessionId: planState.sessionId,
          date: planState.lastTransitionAt,
          summary: planState.plan?.summary ?? "",
          intent: planState.intent,
        },
        ...prefs.recentSessions.filter((s) => s.sessionId !== planState.sessionId),
      ].slice(0, RECENT_SESSIONS_MAX);
    }

    await this.save(prefs);
  }

  // ─── 从历史全量重导 ──────────────────────────────────────────

  async refreshFromHistory(planStatesDir?: string): Promise<UserPreferences> {
    await this.ensureInit();
    const psDir = planStatesDir ?? path.join(os.homedir(), ".pi", "agent", "plan-states");

    // 1. 加载所有 plan-states（仅保留有 intent 的）
    const planStates: PlanState[] = [];
    try {
      const files = await fs.readdir(psDir);
      for (const f of files.filter((f) => f.endsWith(".json"))) {
        try {
          const content = await fs.readFile(path.join(psDir, f), "utf-8");
          const ps = JSON.parse(content) as PlanState;
          if (ps.intent && Object.keys(ps.intent).length > 0) planStates.push(ps);
        } catch { /* skip malformed */ }
      }
    } catch { /* dir doesn't exist */ }

    if (planStates.length === 0) {
      const empty = this.empty();
      try {
        const orders = await getBookingService().getOrdersByUser(this.userId);
        empty.stats.totalBookings = orders.length;
      } catch { /* ignore */ }
      await this.save(empty);
      return empty;
    }

    // 2. 统计每个字段出现频次
    const counters = new Map<string, Map<string, number>>();
    const count = (key: string, value: unknown): void => {
      if (value === undefined || value === null) return;
      const v = typeof value === "object" ? JSON.stringify(value) : String(value);
      if (!counters.has(key)) counters.set(key, new Map());
      const m = counters.get(key)!;
      m.set(v, (m.get(v) ?? 0) + 1);
    };

    for (const ps of planStates) {
      const i = ps.intent;
      count("departurePoint", i.departurePoint);
      count("partySize", i.partySize);
      count("groupType", i.groupType);
      count("budgetPerPerson", i.budgetPerPerson);
      count("mood", i.mood);
      for (const c of i.preferredCategories ?? []) count(`category:${c}`, c);
      for (const d of i.dietaryRestrictions ?? []) count(`dietary:${d}`, d);
    }

    const mostCommon = (key: string): string | null => {
      const m = counters.get(key);
      if (!m) return null;
      let bestKey = "";
      let bestCount = 0;
      for (const [k, c] of m) {
        if (c > bestCount) { bestCount = c; bestKey = k; }
      }
      return bestKey || null;
    };

    // 3. 推导 defaults（出现频率 >= 50% 的字段）
    const threshold = Math.max(1, Math.ceil(planStates.length * DEFAULT_THRESHOLD));
    const newDefaults: UserPreferencesDefaults = {};

    const dp = mostCommon("departurePoint");
    if (dp) newDefaults.departurePoint = JSON.parse(dp) as UserDeparturePoint;

    const ps = mostCommon("partySize");
    if (ps !== null) {
      const n = Number(ps);
      if (!Number.isNaN(n)) newDefaults.partySize = n;
    }

    const gt = mostCommon("groupType");
    if (gt) newDefaults.groupType = gt as CapturedIntent["groupType"];

    const bp = mostCommon("budgetPerPerson");
    if (bp !== null) {
      const n = Number(bp);
      if (!Number.isNaN(n)) newDefaults.budgetPerPerson = n;
    }

    const mood = mostCommon("mood");
    if (mood) newDefaults.mood = mood;

    const cats: string[] = [];
    for (const [k, m] of counters) {
      if (!k.startsWith("category:")) continue;
      let total = 0;
      for (const c of m.values()) total += c;
      if (total >= threshold) cats.push(k.slice("category:".length));
    }
    if (cats.length) newDefaults.preferredCategories = cats;

    const diet: string[] = [];
    for (const [k, m] of counters) {
      if (!k.startsWith("dietary:")) continue;
      let total = 0;
      for (const c of m.values()) total += c;
      if (total >= threshold) diet.push(k.slice("dietary:".length));
    }
    if (diet.length) newDefaults.dietaryRestrictions = diet;

    // 4. Stats: restaurants from bookings (authoritative), categories from intent
    const bookingService = getBookingService();
    let orders: Awaited<ReturnType<typeof bookingService.getOrdersByUser>> = [];
    try {
      orders = await bookingService.getOrdersByUser(this.userId);
    } catch { /* ignore */ }
    const successful = orders.filter((o) => o.status === "confirmed" || o.status === "notified");

    const restaurantCount = new Map<string, { count: number; lastBookedAt: number }>();
    for (const o of successful) {
      const r = restaurantCount.get(o.restaurantName) ?? { count: 0, lastBookedAt: 0 };
      r.count++;
      r.lastBookedAt = Math.max(r.lastBookedAt, o.confirmedAt ?? o.createdAt);
      restaurantCount.set(o.restaurantName, r);
    }
    const favoriteRestaurants = Array.from(restaurantCount.entries())
      .map(([name, v]) => ({ name, count: v.count, lastBookedAt: v.lastBookedAt }))
      .sort((a, b) => b.count - a.count || b.lastBookedAt - a.lastBookedAt)
      .slice(0, 5);

    const categoryCount = new Map<string, number>();
    let totalBudget = 0;
    let budgetCount = 0;
    for (const ps of planStates) {
      for (const c of ps.intent.preferredCategories ?? []) {
        categoryCount.set(c, (categoryCount.get(c) ?? 0) + 1);
      }
      if (ps.intent.budgetPerPerson !== undefined) {
        totalBudget += ps.intent.budgetPerPerson;
        budgetCount++;
      }
    }
    const favoriteCategories = Array.from(categoryCount.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const newStats: UserPreferencesStats = {
      totalSessions: planStates.length,
      totalBookings: orders.length,
      totalCompletedPlans: planStates.filter((ps) => ps.phase === "completed").length,
      favoriteRestaurants,
      favoriteCategories,
      averageBudget: budgetCount > 0 ? Math.round(totalBudget / budgetCount) : 0,
    };

    // 5. Recent sessions: last 5 by lastTransitionAt (with a plan)
    const recentSessions: UserPreferencesRecentSession[] = planStates
      .filter((ps) => ps.plan && Object.keys(ps.intent).length > 0)
      .sort((a, b) => b.lastTransitionAt - a.lastTransitionAt)
      .slice(0, RECENT_SESSIONS_MAX)
      .map((ps) => ({
        sessionId: ps.sessionId,
        date: ps.lastTransitionAt,
        summary: ps.plan!.summary,
        intent: ps.intent,
      }));

    const prefs: UserPreferences = {
      userId: this.userId,
      updatedAt: Date.now(),
      defaults: newDefaults,
      stats: newStats,
      recentSessions,
    };
    await this.save(prefs);
    return prefs;
  }
}

// ─── 单例 ──────────────────────────────────────────────────────────

let _instance: UserPreferencesStore | null = null;
export function getUserPreferencesStore(userId: string = DEFAULT_USER_ID): UserPreferencesStore {
  if (!_instance || _instance.userId !== userId) {
    _instance = new UserPreferencesStore(userId);
  }
  return _instance;
}
