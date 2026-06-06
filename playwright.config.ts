import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config — visual regression for /activity page.
 *
 * Pre-req: dev server must be running on the configured port.
 * Run:    npm run test:visual
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_SERVER ?? "http://localhost:30142",
    headless: true,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
