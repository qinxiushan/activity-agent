// lib/storage/pg-repos.ts — PostgreSQL 后端实现（阶段 2 T1）
//
// 三张表（plan_states / bookings / user_profiles）的 upsert + 查询。
// 所有 SQL 走 lib/db.ts 的 pg Pool；未配置 DATABASE_URL 时 getPool() 抛错，
// 因此上层（lib/storage/index.ts）只在 STORAGE_BACKEND=postgres 时创建这些 repo。

import type { PlanStateRepo, BookingRepo, UserProfileRepo } from "./types";
import type { PlanState } from "../plan-state";
import type { BookingOrder } from "../booking-service";
import type { UserPreferences } from "../user-preferences";
import { getPool } from "../db";

// ─── PlanState PG 实现 ────────────────────────────────────────────

export function createPgPlanStateRepo(): PlanStateRepo {
  return {
    async save(state: PlanState): Promise<void> {
      await getPool().query(
        `INSERT INTO plan_states (session_id, user_id, phase, turn_count, clarification_count, intent, plan, history, last_transition_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (session_id) DO UPDATE SET
           user_id=EXCLUDED.user_id,
           phase=EXCLUDED.phase,
           turn_count=EXCLUDED.turn_count,
           clarification_count=EXCLUDED.clarification_count,
           intent=EXCLUDED.intent,
           plan=EXCLUDED.plan,
           history=EXCLUDED.history,
           last_transition_at=EXCLUDED.last_transition_at,
           updated_at=now()`,
        [
          state.sessionId,
          state.userId ?? null,
          state.phase,
          state.turnCount,
          state.clarificationCount,
          JSON.stringify(state.intent),
          state.plan ? JSON.stringify(state.plan) : null,
          JSON.stringify(state.history),
          state.lastTransitionAt,
        ],
      );
    },

    async load(sessionId: string): Promise<PlanState | null> {
      const { rows } = await getPool().query(
        "SELECT * FROM plan_states WHERE session_id=$1",
        [sessionId],
      );
      if (rows.length === 0) return null;
      return rowToPlanState(rows[0]);
    },

    async listByUser(userId: string): Promise<PlanState[]> {
      const { rows } = await getPool().query(
        "SELECT * FROM plan_states WHERE user_id=$1 ORDER BY last_transition_at DESC",
        [userId],
      );
      return rows.map(rowToPlanState);
    },

    async listAll(): Promise<PlanState[]> {
      const { rows } = await getPool().query(
        "SELECT * FROM plan_states ORDER BY last_transition_at DESC",
      );
      return rows.map(rowToPlanState);
    },
  };
}

interface PlanStateRow {
  session_id: string;
  user_id: string | null;
  phase: string;
  turn_count: number;
  clarification_count: number;
  intent: unknown;
  plan: unknown | null;
  history: unknown;
  last_transition_at: string | number;
}

function rowToPlanState(row: PlanStateRow): PlanState {
  return {
    sessionId: row.session_id,
    userId: row.user_id ?? undefined,
    phase: row.phase as PlanState["phase"],
    turnCount: Number(row.turn_count),
    clarificationCount: Number(row.clarification_count),
    intent: (typeof row.intent === "object" ? row.intent : {}) as PlanState["intent"],
    plan: (typeof row.plan === "object" ? row.plan : null) as PlanState["plan"],
    history: Array.isArray(row.history)
      ? (row.history as PlanState["history"])
      : [],
    lastTransitionAt: Number(row.last_transition_at),
  };
}

// ─── Booking PG 实现 ──────────────────────────────────────────────

export function createPgBookingRepo(): BookingRepo {
  return {
    async save(order: BookingOrder): Promise<void> {
      await getPool().query(
        `INSERT INTO bookings (order_id, user_id, status, restaurant_id, restaurant_name, date, time, party_size, payload, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (order_id) DO UPDATE SET
           status=EXCLUDED.status,
           payload=EXCLUDED.payload,
           updated_at=EXCLUDED.updated_at`,
        [
          order.orderId,
          order.userId,
          order.status,
          order.restaurantId,
          order.restaurantName,
          order.date,
          order.time,
          order.partySize,
          JSON.stringify(order),
          order.createdAt,
          order.updatedAt,
        ],
      );
    },

    async load(orderId: string): Promise<BookingOrder | null> {
      const { rows } = await getPool().query(
        "SELECT * FROM bookings WHERE order_id=$1",
        [orderId],
      );
      if (rows.length === 0) return null;
      return rowToBooking(rows[0]);
    },

    async listByUser(userId: string): Promise<BookingOrder[]> {
      const { rows } = await getPool().query(
        "SELECT * FROM bookings WHERE user_id=$1 ORDER BY created_at DESC",
        [userId],
      );
      return rows.map(rowToBooking);
    },

    async listAll(): Promise<BookingOrder[]> {
      const { rows } = await getPool().query(
        "SELECT * FROM bookings ORDER BY created_at DESC",
      );
      return rows.map(rowToBooking);
    },
  };
}

interface BookingRow {
  order_id: string;
  user_id: string;
  status: string;
  restaurant_id: string;
  restaurant_name: string;
  date: string;
  time: string;
  party_size: number;
  payload: unknown;
  created_at: string | number;
  updated_at: string | number;
}

function rowToBooking(row: BookingRow): BookingOrder {
  // payload 存的是完整 BookingOrder 快照，直接用它还原所有字段
  if (typeof row.payload === "object" && row.payload !== null) {
    return row.payload as BookingOrder;
  }
  // 兜底：从列值组装（极少发生，仅 payload 被意外覆盖时）
  return {
    orderId: row.order_id,
    userId: row.user_id,
    status: row.status as BookingOrder["status"],
    restaurantId: row.restaurant_id,
    restaurantName: row.restaurant_name,
    date: row.date,
    time: row.time,
    partySize: Number(row.party_size),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    retryCount: 0,
  };
}

// ─── UserProfile PG 实现 ──────────────────────────────────────────

export function createPgUserProfileRepo(): UserProfileRepo {
  return {
    async save(prefs: UserPreferences): Promise<void> {
      await getPool().query(
        `INSERT INTO user_profiles (user_id, data)
         VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET
           data=EXCLUDED.data,
           updated_at=now()`,
        [prefs.userId, JSON.stringify(prefs)],
      );
    },

    async load(userId: string): Promise<UserPreferences | null> {
      const { rows } = await getPool().query(
        "SELECT * FROM user_profiles WHERE user_id=$1",
        [userId],
      );
      if (rows.length === 0) return null;
      const row = rows[0] as { data: unknown };
      return (typeof row.data === "object" ? row.data : null) as UserPreferences | null;
    },
  };
}
