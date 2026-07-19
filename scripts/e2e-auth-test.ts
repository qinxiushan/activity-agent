/**
 * AUTH_MODE=required E2E wrapper
 *
 * 目标：
 * 1. 自动启动一个 required-auth dev server（若目标地址尚未运行）
 * 2. 运行 Playwright 的 auth-required 专项
 * 3. 结束后清理由本脚本启动的 server
 *
 * 约定：
 * - 默认端口 30143，避免和日常 30142 dev server 冲突
 * - 默认直连本地 compose/dev PG：postgres://activity:activity_dev@127.0.0.1:55432/activity_agent
 * - 可通过 E2E_SERVER / DATABASE_URL / REDIS_URL 覆盖
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as wait } from "node:timers/promises";

const DEFAULT_SERVER_URL = process.env.E2E_SERVER ?? "http://127.0.0.1:30143";
const READY_PATH = "/login";
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
const SHUTDOWN_GRACE_MS = 3_000;
const MAX_PORT_SCAN = 10;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://activity:activity_dev@127.0.0.1:55432/activity_agent";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:56379";

let devProcess: ChildProcess | null = null;
let killedByUs = false;
let serverUrl = DEFAULT_SERVER_URL;

function log(prefix: string, msg: string): void {
  console.log(`[e2e:auth] ${prefix} ${msg}`);
}

function getPortFromServerUrl(url: string): string {
  return String(new URL(url).port || "30143");
}

function buildServerUrl(url: string, port: number): string {
  const parsed = new URL(url);
  parsed.port = String(port);
  return parsed.toString().replace(/\/$/, "");
}

async function canBindPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer();
    const finalize = (ok: boolean) => server.close(() => resolve(ok));

    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => finalize(true));
  });
}

async function pickLaunchUrl(preferredUrl: string): Promise<string> {
  const basePort = Number(getPortFromServerUrl(preferredUrl));
  if (Number.isNaN(basePort)) return preferredUrl;

  for (let offset = 0; offset < MAX_PORT_SCAN; offset++) {
    const candidatePort = basePort + offset;
    if (await canBindPort(candidatePort)) {
      return buildServerUrl(preferredUrl, candidatePort);
    }
  }

  return preferredUrl;
}

async function isServerReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}${READY_PATH}`, {
      signal: AbortSignal.timeout(2000),
      redirect: "manual",
    });
    return res.ok || res.status === 307 || res.status === 308;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    if (await isServerReachable()) {
      log("✓", `server reachable after ${attempt} polls (${Math.round((Date.now() - start) / 1000)}s)`);
      return true;
    }
    await wait(POLL_INTERVAL_MS);
  }
  return false;
}

function startDevServer(): ChildProcess {
  const port = getPortFromServerUrl(serverUrl);
  log("→", `starting required-auth dev server on ${serverUrl}`);
  const child = spawn("node_modules/.bin/next", ["dev", "-p", port], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      AUTH_MODE: "required",
      AUTH_SECRET: process.env.AUTH_SECRET ?? "e2e-auth-secret",
      AUTH_E2E: "1",
      STORAGE_BACKEND: process.env.STORAGE_BACKEND ?? "postgres",
      RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED ?? "false",
      DATABASE_URL,
      REDIS_URL,
      PORT: port,
    },
  });

  child.stdout?.on("data", (chunk) => process.stdout.write(`[auth-dev] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[auth-dev] ${chunk}`));
  child.on("error", (err) => log("✗", `dev server spawn error: ${err.message}`));
  return child;
}

async function killDevServer(): Promise<void> {
  if (!devProcess?.pid) return;
  const pid = devProcess.pid;
  killedByUs = true;
  log("→", `stopping dev server (pid ${pid})`);
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { devProcess.kill("SIGTERM"); } catch { /* noop */ }
  }
  await wait(SHUTDOWN_GRACE_MS);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { devProcess.kill("SIGKILL"); } catch { /* noop */ }
  }
}

async function runPlaywright(): Promise<number> {
  log("→", `running auth-required Playwright suite against ${serverUrl}`);
  return new Promise<number>((resolve) => {
    const child = spawn("node_modules/.bin/playwright", ["test", "tests/auth-required.spec.ts"], {
      stdio: "inherit",
      env: {
        ...process.env,
        AUTH_E2E: "1",
        AUTH_MODE: "required",
        AUTH_SECRET: process.env.AUTH_SECRET ?? "e2e-auth-secret",
        STORAGE_BACKEND: process.env.STORAGE_BACKEND ?? "postgres",
        RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED ?? "false",
        DATABASE_URL,
        REDIS_URL,
        E2E_SERVER: serverUrl,
      },
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      log("✗", `playwright spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  log("→", `target: ${serverUrl}`);
  const alreadyUp = await isServerReachable();
  if (alreadyUp) {
    log("✓", "server already running — reusing it");
  } else {
    const preferredPort = getPortFromServerUrl(serverUrl);
    serverUrl = await pickLaunchUrl(serverUrl);
    const actualPort = getPortFromServerUrl(serverUrl);
    if (preferredPort !== actualPort) {
      log("!", `port ${preferredPort} is occupied but not healthy; falling back to ${actualPort}`);
    }
    devProcess = startDevServer();
    const ready = await waitForServer(READY_TIMEOUT_MS);
    if (!ready) {
      log("✗", `server did not become ready in ${READY_TIMEOUT_MS / 1000}s`);
      await killDevServer();
      process.exit(1);
    }
  }

  const exitCode = await runPlaywright();
  log("→", `auth suite exited with code ${exitCode}`);
  if (devProcess) await killDevServer();
  process.exit(exitCode);
}

process.on("SIGINT", async () => {
  log("!", "SIGINT received");
  if (devProcess && !killedByUs) await killDevServer();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  log("!", "SIGTERM received");
  if (devProcess && !killedByUs) await killDevServer();
  process.exit(143);
});

main().catch(async (error) => {
  console.error("[e2e:auth] crashed:", error);
  if (devProcess) await killDevServer();
  process.exit(1);
});
