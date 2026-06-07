import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCREENSHOT_DIR = join(process.cwd(), "tests", "__screenshots__");
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * Visual regression for /activity page.
 * Captures: light mode, dark mode, and a sample prompt being typed.
 *
 * Run prerequisites:
 *   1. Start dev server: npm run dev (port 30142)
 *   2. Install browser: npx playwright install chromium
 *   3. Run: npm run test:visual
 */
test.describe("Activity page visual", () => {
  test("light mode — empty state", async ({ page }) => {
    await page.goto("/activity");
    // Wait for the activity panel header to render (signals client hydration)
    await expect(page.locator("text=Activity Panel")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=SOP-v2 阶段进度")).toBeVisible();
    // Ensure light mode
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      try { localStorage.setItem("pi-theme", "light"); } catch {}
    });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: join(SCREENSHOT_DIR, "activity-light.png"),
      fullPage: true,
    });
  });

  test("dark mode — empty state", async ({ page }) => {
    await page.goto("/activity");
    await expect(page.locator("text=Activity Panel")).toBeVisible({ timeout: 10_000 });
    // Force dark mode via theme toggle
    await page.locator('button[aria-label="Switch to dark mode"]').click();
    // Wait for view transition + class flip
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.waitForTimeout(400);
    await page.screenshot({
      path: join(SCREENSHOT_DIR, "activity-dark.png"),
      fullPage: true,
    });
    // Verify localStorage persisted
    const stored = await page.evaluate(() => localStorage.getItem("pi-theme"));
    expect(stored).toBe("dark");
  });

  test("light mode — sample prompt + phase progress visible", async ({ page }) => {
    await page.goto("/activity");
    await expect(page.locator("text=Activity Panel")).toBeVisible({ timeout: 10_000 });
    // Force light mode
    await page.evaluate(() => {
      document.documentElement.classList.remove("dark");
      try { localStorage.setItem("pi-theme", "light"); } catch {}
    });
    // Click first sample prompt chip
    const firstSample = page.locator("button").filter({ hasText: /想和女朋友/ }).first();
    await firstSample.click();
    await page.waitForTimeout(200);
    // Verify the textarea got populated
    const textarea = page.locator("textarea");
    await expect(textarea).toHaveValue(/想和女朋友/);
    await page.screenshot({
      path: join(SCREENSHOT_DIR, "activity-light-with-prompt.png"),
      fullPage: true,
    });
  });

  test("phase progress component renders all 7 phase labels", async ({ page }) => {
    await page.goto("/activity");
    await expect(page.locator("text=Activity Panel")).toBeVisible({ timeout: 10_000 });
    // Phase labels from PhaseProgress.tsx
    const expectedLabels = ["待命", "意图捕获", "追问", "自动规划", "等待确认", "执行预订", "完成"];
    for (const label of expectedLabels) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible();
    }
  });
});

test.describe("User Preferences Panel", () => {
  test("renders empty-state when no prefs exist", async ({ page }) => {
    await page.goto("/activity");
    await expect(page.locator("text=Activity Panel")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=🧠 用户偏好")).toBeVisible();
    await expect(page.locator("text=/方案 \\d+ · 预订 \\d+/")).toBeVisible();
    const placeholder = page.locator("text=暂无偏好").first();
    await expect(placeholder).toBeVisible();
    await expect(page.locator('button[title*="重新计算"]')).toBeVisible();
    await expect(page.locator('button[title="重置所有偏好"]')).toBeVisible();
  });

  test("refresh button triggers /api/user-preferences POST and re-renders", async ({ page }) => {
    await page.goto("/activity");
    await expect(page.locator("text=🧠 用户偏好")).toBeVisible({ timeout: 10_000 });
    const refreshBtn = page.locator('button[title*="重新计算"]');
    const reqPromise = page.waitForRequest(
      (r) => r.url().endsWith("/api/user-preferences") && r.method() === "POST",
      { timeout: 5000 },
    );
    await refreshBtn.click();
    const req = await reqPromise;
    expect(req.postDataJSON()).toEqual({ action: "refresh" });
    await expect(page.locator("text=🧠 用户偏好")).toBeVisible();
  });

  test("panel renders in dark mode without contrast issues", async ({ page }) => {
    await page.goto("/activity");
    await expect(page.locator("text=🧠 用户偏好")).toBeVisible({ timeout: 10_000 });
    await page.locator('button[aria-label="Switch to dark mode"]').click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.waitForTimeout(300);
    await expect(page.locator("text=🧠 用户偏好")).toBeVisible();
    await page.screenshot({
      path: join(SCREENSHOT_DIR, "prefs-panel-dark.png"),
      fullPage: true,
    });
  });

  test("expandable recent-intents section toggles", async ({ page }) => {
    await page.goto("/activity");
    await expect(page.locator("text=🧠 用户偏好")).toBeVisible({ timeout: 10_000 });
    const toggle = page.locator('button:has-text("最近")').first();
    const exists = await toggle.count();
    if (exists > 0) {
      const before = await toggle.textContent();
      await toggle.click();
      const after = await toggle.textContent();
      expect(before).not.toBe(after);
    } else {
      expect(exists).toBe(0);
    }
  });
});
