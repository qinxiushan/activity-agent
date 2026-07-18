import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { hashPassword } from "../lib/auth-session";

const AUTH_E2E_ENABLED = process.env.AUTH_E2E === "1";

let pool: Pool;

async function ensureUsers(): Promise<void> {
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
  }
}

async function login(page: Page, username: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL(/\/$/, { timeout: 15_000 });
}

test.describe("AUTH_MODE=required acceptance", () => {
  test.skip(!AUTH_E2E_ENABLED, "Set AUTH_E2E=1 to run required-auth acceptance tests.");

  test.beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for auth-required Playwright tests");
    }

    pool = new Pool({ connectionString: databaseUrl });
    await ensureUsers();
  });

  test.afterAll(async () => {
    await pool?.end();
  });

  test("redirects to login, authenticates, and supports logout", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/\/login$/, { timeout: 15_000 });

    await page.getByLabel("用户名").fill("alice");
    await page.getByLabel("密码").fill("wrong-password");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByText("用户名或密码错误")).toBeVisible();

    await page.getByLabel("密码").fill("alice123");
    await page.getByRole("button", { name: "登录" }).click();
    await page.waitForURL(/\/$/, { timeout: 15_000 });

    const whoamiRes = await page.context().request.get("/api/whoami");
    expect(whoamiRes.ok()).toBeTruthy();
    const whoami = await whoamiRes.json() as {
      userId: string | null;
      username: string | null;
      authed: boolean;
      mode: string;
    };
    expect(whoami).toMatchObject({
      userId: "alice",
      username: "alice",
      authed: true,
      mode: "required",
    });

    const devLoginRes = await page.context().request.get("/api/dev-login");
    expect(devLoginRes.status()).toBe(404);

    await page.getByRole("button", { name: "退出" }).click();
    await page.waitForURL(/\/login$/, { timeout: 15_000 });
  });

  test("rejects forged signed-session cookies", async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: process.env.E2E_SERVER ?? "http://localhost:30142",
    });
    await context.addCookies([{
      name: "pi_auth",
      value: "forged.invalid.signature",
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    }]);

    const response = await context.request.get("/api/user-preferences");
    expect(response.status()).toBe(401);
    await context.close();
  });

  test("enforces plan-state ownership", async ({ page }) => {
    const aliceSessionId = `alice-${randomUUID()}`;
    const bobSessionId = `bob-${randomUUID()}`;
    const now = Date.now();

    await pool.query(
      `INSERT INTO plan_states
        (session_id, user_id, phase, turn_count, clarification_count, intent, plan, history, last_transition_at)
       VALUES
        ($1, $2, 'planning', 1, 0, '{}'::jsonb, NULL, '[]'::jsonb, $3),
        ($4, $5, 'planning', 1, 0, '{}'::jsonb, NULL, '[]'::jsonb, $3)`,
      [aliceSessionId, "alice", now, bobSessionId, "bob"],
    );

    try {
      await login(page, "alice", "alice123");

      const ownRes = await page.context().request.get(`/api/plan-state/${aliceSessionId}`);
      expect(ownRes.status()).toBe(200);
      const ownState = await ownRes.json() as { userId?: string; sessionId?: string };
      expect(ownState).toMatchObject({ userId: "alice", sessionId: aliceSessionId });

      const foreignRes = await page.context().request.get(`/api/plan-state/${bobSessionId}`);
      expect(foreignRes.status()).toBe(403);
    } finally {
      await pool.query("DELETE FROM plan_states WHERE session_id = ANY($1::text[])", [[aliceSessionId, bobSessionId]]);
    }
  });
});
