#!/bin/sh
set -eu

mkdir -p /home/nextjs/.pi/agent
chown -R nextjs:nodejs /home/nextjs /app

cat <<'LOG'
[entrypoint] ensuring postgres schema and seeded users
LOG

su-exec nextjs:nodejs node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: url });
  try {
    const migrationsDir = path.join(process.cwd(), "db", "migrations");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await pool.query("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.version));
    const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`[entrypoint] applied migration ${file}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    const users = [
      {
        id: "alice",
        username: "alice",
        passwordHash: "$2b$12$YqU4WLtPI7NQHSqqoWici.RXGw35hhpmvP/PTgR2zPt.RxVc1udQ6",
      },
      {
        id: "bob",
        username: "bob",
        passwordHash: "$2b$12$cT0aNiOAPeyoVe5z1eeBAuCoKaCBuy1d0rZg4JgsxMaooU8TBjMaG",
      },
    ];

    for (const user of users) {
      await pool.query(
        `INSERT INTO users (id, username, password_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET
           username=EXCLUDED.username,
           password_hash=EXCLUDED.password_hash`,
        [user.id, user.username, user.passwordHash],
      );
    }

    console.log("[entrypoint] schema ready and users seeded");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("[entrypoint] bootstrap failed:", error);
  process.exit(1);
});
NODE

echo "[entrypoint] starting app: $*"
exec su-exec nextjs:nodejs "$@"
