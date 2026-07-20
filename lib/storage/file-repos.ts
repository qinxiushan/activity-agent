// lib/storage/file-repos.ts — file 后端实现
//
// 从 plan-state.ts / booking-service.ts / user-preferences.ts
// 原样搬移文件读写逻辑，封装为 repo 对象。
// 路径和格式与阶段 1 完全一致，确保 file 模式向前兼容。

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PlanStateRepo, BookingRepo, UserProfileRepo } from "./types";
import type { PlanState } from "../plan-state";
import type { BookingOrder } from "../booking-service";
import type { UserPreferences } from "../user-preferences";

// ─── 目录常量（与阶段 1 一致）─────────────────────────────────────

const PI_AGENT = path.join(os.homedir(), ".pi", "agent");
const PLAN_STATES_DIR = path.join(PI_AGENT, "plan-states");
const BOOKINGS_DIR = path.join(PI_AGENT, "bookings");
const USER_PROFILES_DIR = path.join(PI_AGENT, "user-profiles");

// ─── PlanState 文件实现 ───────────────────────────────────────────

export function createFilePlanStateRepo(dir?: string): PlanStateRepo {
  const root = dir ?? PLAN_STATES_DIR;
  return {
    async save(state: PlanState): Promise<void> {
      await fs.mkdir(root, { recursive: true });
      const file = path.join(root, `${state.sessionId}.json`);
      await fs.writeFile(file, JSON.stringify(state, null, 2), "utf-8");
    },

    async load(sessionId: string): Promise<PlanState | null> {
      try {
        const file = path.join(root, `${sessionId}.json`);
        const content = await fs.readFile(file, "utf-8");
        return JSON.parse(content) as PlanState;
      } catch {
        return null;
      }
    },

    async listByUser(_userId: string): Promise<PlanState[]> {
      return this.listAll();
    },

    async listAll(): Promise<PlanState[]> {
      try {
        const files = await fs.readdir(root);
        const results: PlanState[] = [];
        for (const f of files.filter((f) => f.endsWith(".json"))) {
          try {
            const content = await fs.readFile(path.join(root, f), "utf-8");
            results.push(JSON.parse(content) as PlanState);
          } catch { /* skip malformed */ }
        }
        return results;
      } catch {
        return [];
      }
    },
  };
}

// ─── Booking 文件实现 ─────────────────────────────────────────────

export function createFileBookingRepo(): BookingRepo {
  return {
    async save(order: BookingOrder): Promise<void> {
      await fs.mkdir(BOOKINGS_DIR, { recursive: true });
      const file = path.join(BOOKINGS_DIR, `${order.orderId}.json`);
      await fs.writeFile(file, JSON.stringify(order, null, 2), "utf-8");
    },

    async load(orderId: string): Promise<BookingOrder | null> {
      try {
        const file = path.join(BOOKINGS_DIR, `${orderId}.json`);
        const content = await fs.readFile(file, "utf-8");
        return JSON.parse(content) as BookingOrder;
      } catch {
        return null;
      }
    },

    async listByUser(userId: string): Promise<BookingOrder[]> {
      const all = await this.listAll();
      return all
        .filter((o) => o.userId === userId)
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async listAll(): Promise<BookingOrder[]> {
      try {
        const files = await fs.readdir(BOOKINGS_DIR);
        const results: BookingOrder[] = [];
        for (const f of files.filter((f) => f.endsWith(".json"))) {
          try {
            const content = await fs.readFile(path.join(BOOKINGS_DIR, f), "utf-8");
            results.push(JSON.parse(content) as BookingOrder);
          } catch { /* skip malformed */ }
        }
        return results;
      } catch {
        return [];
      }
    },

    async findByIdempotencyKey(key: string): Promise<BookingOrder | null> {
      const all = await this.listAll();
      return all.find((o) => o.idempotencyKey === key) ?? null;
    },
  };
}

// ─── UserProfile 文件实现 ─────────────────────────────────────────

export function createFileUserProfileRepo(): UserProfileRepo {
  return {
    async save(prefs: UserPreferences): Promise<void> {
      await fs.mkdir(USER_PROFILES_DIR, { recursive: true });
      const file = path.join(USER_PROFILES_DIR, `${prefs.userId}.json`);
      await fs.writeFile(file, JSON.stringify(prefs, null, 2), "utf-8");
    },

    async load(userId: string): Promise<UserPreferences | null> {
      try {
        const file = path.join(USER_PROFILES_DIR, `${userId}.json`);
        const content = await fs.readFile(file, "utf-8");
        return JSON.parse(content) as UserPreferences;
      } catch {
        return null;
      }
    },
  };
}
