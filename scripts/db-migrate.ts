/**
 * scripts/db-migrate.ts — 极简 SQL 迁移器（阶段 2 T0）
 *
 * 行为：
 * 1. 加载 .env（Node 22 内置 process.loadEnvFile，文件不存在则忽略）
 * 2. 确保 schema_migrations 表存在
 * 3. 按文件名顺序执行 db/migrations/*.sql 中尚未应用的迁移
 *    每个迁移在单独事务中执行（BEGIN → sql → 记录版本 → COMMIT，失败 ROLLBACK）
 * 4. 幂等：已应用的版本自动跳过，可重复运行
 *
 * 用法：
 *   npm run db:migrate            # 读 .env 的 DATABASE_URL
 *   DATABASE_URL=... npm run db:migrate
 *
 * 退出码：0 成功 / 1 迁移执行失败 / 2 前置条件不满足（无 DATABASE_URL 或连不上）
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// 先于 lib/db 的 env 读取加载 .env（lib/db 是惰性读 env，import 顺序无碍，此处求稳）
try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch {
  /* .env 不存在时忽略（CI 直接注入 env） */
}

import { getPool, isDbConfigured, closePool, pingDb } from "../lib/db";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

async function main(): Promise<void> {
  if (!isDbConfigured()) {
    console.error("✗ DATABASE_URL is not set. Copy .env.example to .env or export it.");
    process.exit(2);
  }
  if (!(await pingDb(3_000))) {
    console.error("✗ Cannot reach PostgreSQL. Is it running? Try: npm run infra:up");
    process.exit(2);
  }

  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const { rows } = await pool.query<{ version: string }>(
    "SELECT version FROM schema_migrations",
  );
  const applied = new Set(rows.map((r) => r.version));

  let appliedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    if (applied.has(file)) {
      skippedCount++;
      console.log(`  skip    ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      appliedCount++;
      console.log(`  applied ${file}`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error(`✗ migration ${file} failed:`, e instanceof Error ? e.message : e);
      client.release();
      await closePool();
      process.exit(1);
    }
    client.release();
  }

  console.log(`✓ migrations done: applied=${appliedCount} skipped=${skippedCount}`);
  await closePool();
}

main().catch(async (e) => {
  console.error("💥 migrate crashed:", e);
  await closePool().catch(() => {});
  process.exit(1);
});
