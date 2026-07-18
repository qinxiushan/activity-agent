/**
 * scripts/migrate-file-to-pg.ts — 一次性文件→PG 迁移（阶段 2 T1）
 *
 * 行为：
 * 1. 读取 ~/.pi/agent/plan-states/*.json → upsert plan_states
 * 2. 读取 ~/.pi/agent/bookings/*.json     → upsert bookings
 * 3. 读取 ~/.pi/agent/user-profiles/*.json → upsert user_profiles
 * 4. 每个目录独立统计迁移量、幂等可重跑（upsert 不会重复插入）
 *
 * 前置条件：DATABASE_URL 已配置，PG 已就绪
 * 用法：
 *   npx tsx scripts/migrate-file-to-pg.ts
 *
 * 退出码：0 成功 / 1 迁移执行失败 / 2 前置条件不满足
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch { /* .env 不存在时忽略 */ }

import { getPool, isDbConfigured, pingDb, closePool } from "../lib/db";
import type { PlanState } from "../lib/plan-state";
import type { BookingOrder } from "../lib/booking-service";
import type { UserPreferences } from "../lib/user-preferences";

const PI_AGENT = path.join(os.homedir(), ".pi", "agent");
const DIRS = {
  planStates: path.join(PI_AGENT, "plan-states"),
  bookings: path.join(PI_AGENT, "bookings"),
  userProfiles: path.join(PI_AGENT, "user-profiles"),
};

async function scanJsonFile(dir: string): Promise<unknown[]> {
  try {
    const files = await fs.readdir(dir);
    const results: unknown[] = [];
    for (const f of files.filter((f) => f.endsWith(".json"))) {
      try {
        const content = await fs.readFile(path.join(dir, f), "utf-8");
        results.push(JSON.parse(content) as unknown);
      } catch { /* skip malformed */ }
    }
    return results;
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  if (!isDbConfigured()) {
    console.error("✗ DATABASE_URL is not configured.");
    process.exit(2);
  }
  if (!(await pingDb(3_000))) {
    console.error("✗ Cannot reach PostgreSQL. Run: npm run infra:up");
    process.exit(2);
  }

  const pool = getPool();
  let total = 0;

  // ─── plan_states ───────────────────────────────────────────
  {
    const rows = await scanJsonFile(DIRS.planStates) as PlanState[];
    for (const s of rows) {
      await pool.query(
        `INSERT INTO plan_states (session_id, phase, turn_count, clarification_count, intent, plan, history, last_transition_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (session_id) DO UPDATE SET
           phase=EXCLUDED.phase, turn_count=EXCLUDED.turn_count,
           clarification_count=EXCLUDED.clarification_count,
           intent=EXCLUDED.intent, plan=EXCLUDED.plan,
           history=EXCLUDED.history, last_transition_at=EXCLUDED.last_transition_at,
           updated_at=now()`,
        [
          s.sessionId, s.phase, s.turnCount, s.clarificationCount,
          JSON.stringify(s.intent), s.plan ? JSON.stringify(s.plan) : null,
          JSON.stringify(s.history), s.lastTransitionAt,
        ],
      );
    }
    console.log(`  plan_states: ${rows.length} rows migrated`);
    total += rows.length;
  }

  // ─── bookings ──────────────────────────────────────────────
  {
    const rows = await scanJsonFile(DIRS.bookings) as BookingOrder[];
    for (const o of rows) {
      await pool.query(
        `INSERT INTO bookings (order_id, user_id, status, restaurant_id, restaurant_name, date, time, party_size, payload, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (order_id) DO UPDATE SET
           status=EXCLUDED.status, payload=EXCLUDED.payload, updated_at=EXCLUDED.updated_at`,
        [
          o.orderId, o.userId, o.status,
          o.restaurantId, o.restaurantName, o.date, o.time, o.partySize,
          JSON.stringify(o), o.createdAt, o.updatedAt,
        ],
      );
    }
    console.log(`  bookings: ${rows.length} rows migrated`);
    total += rows.length;
  }

  // ─── user_profiles ─────────────────────────────────────────
  {
    const rows = await scanJsonFile(DIRS.userProfiles) as UserPreferences[];
    for (const p of rows) {
      await pool.query(
        `INSERT INTO user_profiles (user_id, data)
         VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
        [p.userId, JSON.stringify(p)],
      );
    }
    console.log(`  user_profiles: ${rows.length} rows migrated`);
    total += rows.length;
  }

  console.log(`✓ migration done: total=${total} rows`);
  await closePool();
}

main().catch(async (e) => {
  console.error("💥 migrate-file-to-pg crashed:", e);
  await closePool().catch(() => {});
  process.exit(1);
});
