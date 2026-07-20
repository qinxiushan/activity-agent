// lib/storage/types.ts — Repository 接口（阶段 2 T1）
// plan-state / bookings / user-preferences 三种持久化后端的抽象契约。
// file 和 pg 实现各自满足同一份接口，上层业务代码不感知底层存储。

import type { PlanState } from "../plan-state";
import type { BookingOrder } from "../booking-service";
import type { UserPreferences } from "../user-preferences";

// ─── PlanStateRepo ────────────────────────────────────────────────

export interface PlanStateRepo {
  /** 持久化单条 plan-state。实现策略：file 用 writeFileSync，pg 用 upsert。 */
  save(state: PlanState): void | Promise<void>;

  /** 按 sessionId 加载（不存在返回 null） */
  load(sessionId: string): PlanState | null | Promise<PlanState | null>;

  /** 列出某用户的所有 plan-states（按 lastTransitionAt 倒序） */
  listByUser(userId: string): PlanState[] | Promise<PlanState[]>;

  /** 列出全部 plan-states（供 refreshFromHistory / 迁移脚本使用） */
  listAll(): PlanState[] | Promise<PlanState[]>;
}

// ─── BookingRepo ──────────────────────────────────────────────────

export interface BookingRepo {
  /** 持久化单条订单（upsert 语义：orderId 为唯一键） */
  save(order: BookingOrder): void | Promise<void>;

  /** 按 orderId 加载 */
  load(orderId: string): BookingOrder | null | Promise<BookingOrder | null>;

  /** 按 userId 列出订单（按 createdAt 倒序） */
  listByUser(userId: string): BookingOrder[] | Promise<BookingOrder[]>;

  /** 列出全部订单（供迁移脚本使用） */
  listAll(): BookingOrder[] | Promise<BookingOrder[]>;

  /** 按幂等键查订单（不存在返回 null）。route-B：防重复下单。 */
  findByIdempotencyKey(key: string): BookingOrder | null | Promise<BookingOrder | null>;
}

// ─── UserProfileRepo ──────────────────────────────────────────────

export interface UserProfileRepo {
  /** 持久化用户偏好（upsert：userId 为唯一键） */
  save(prefs: UserPreferences): void | Promise<void>;

  /** 按 userId 加载（不存在返回 null） */
  load(userId: string): UserPreferences | null | Promise<UserPreferences | null>;
}
