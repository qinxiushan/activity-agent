import { getPool, isDbConfigured } from "../lib/db";
import { hashPassword } from "../lib/auth-session";

async function main() {
  if (!isDbConfigured()) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = getPool();
  const users = [
    { id: "alice", username: "alice", password: "alice123" },
    { id: "bob", username: "bob", password: "bob123" },
  ];

  for (const user of users) {
    await pool.query(
      `INSERT INTO users (id, username, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET
         username=EXCLUDED.username,
         password_hash=EXCLUDED.password_hash`,
      [user.id, user.username, hashPassword(user.password)],
    );
    console.log(`seeded user: ${user.username}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
