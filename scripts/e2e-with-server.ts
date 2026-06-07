/**
 * E2E wrapper: auto-starts dev server, runs real LLM test, cleans up.
 *
 * Before:
 *   1. Start dev server in one terminal:  npm run dev
 *   2. Run e2e test in another:           npm run e2e:real
 *
 * After (one command does both):
 *   npm run e2e
 *
 * Behavior:
 *   - If a dev server is already reachable on E2E_SERVER (default :30142), uses it
 *     and does NOT kill it on exit (so you can re-run the test cheaply).
 *   - If no server is reachable, spawns `npm run dev` in a new process group,
 *     waits up to 60s for /api/sessions to return 200, then runs the test.
 *   - On exit, kills the spawned process group (so the dev server dies with us).
 *   - Exits with the e2e test's exit code, so CI can detect failure.
 *
 * Override server: E2E_SERVER=http://localhost:30142 npm run e2e
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const SERVER_URL = process.env.E2E_SERVER ?? "http://localhost:30142";
const HEALTHCHECK_PATH = "/api/sessions";
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;
const SHUTDOWN_GRACE_MS = 3_000;

let devProcess: ChildProcess | null = null;
let killedByUs = false;

function log(prefix: string, msg: string): void {
  console.log(`[e2e] ${prefix} ${msg}`);
}

async function isServerReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVER_URL}${HEALTHCHECK_PATH}`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
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
  log("→", "starting dev server (no server detected on " + SERVER_URL + ")");
  // detached: true puts the child in its own process group so we can kill the
  // whole tree on exit (next dev forks a couple of helpers).
  const child = spawn("npm", ["run", "dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, FORCE_COLOR: "1" },
  });

  // Forward dev server output with a prefix, but only stderr/stdout if user wants it.
  // We default to piping through so the user sees "ready" messages.
  child.stdout?.on("data", (chunk) => process.stdout.write(`[dev] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[dev] ${chunk}`));

  child.on("error", (err) => {
    log("✗", `dev server spawn error: ${err.message}`);
  });

  return child;
}

async function killDevServer(): Promise<void> {
  if (!devProcess || !devProcess.pid) return;
  killedByUs = true;
  const pid = devProcess.pid;
  log("→", `stopping dev server (pid ${pid})...`);
  try {
    // Negative pid = kill the whole process group (works because detached: true)
    process.kill(-pid, "SIGTERM");
  } catch {
    // Fallback: kill just the child
    try { devProcess.kill("SIGTERM"); } catch { /* already dead */ }
  }
  await wait(SHUTDOWN_GRACE_MS);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { devProcess.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

async function runTest(): Promise<number> {
  log("→", `running e2e test against ${SERVER_URL}`);
  return new Promise<number>((resolve) => {
    const child = spawn("node_modules/.bin/tsx", ["scripts/e2e-real-llm-test.ts"], {
      stdio: "inherit",
      env: { ...process.env, E2E_SERVER: SERVER_URL },
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      log("✗", `test spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  log("→", `target: ${SERVER_URL}`);

  const alreadyUp = await isServerReachable();
  if (alreadyUp) {
    log("✓", "server already running — reusing it (will NOT kill on exit)");
  } else {
    devProcess = startDevServer();
    const ready = await waitForServer(READY_TIMEOUT_MS);
    if (!ready) {
      log("✗", `server did not become ready in ${READY_TIMEOUT_MS / 1000}s`);
      await killDevServer();
      process.exit(1);
    }
  }

  const exitCode = await runTest();
  log("→", `test exited with code ${exitCode}`);

  if (devProcess) await killDevServer();
  process.exit(exitCode);
}

// Make sure Ctrl+C also kills the dev server
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

main().catch(async (e) => {
  console.error("[e2e] crashed:", e);
  if (devProcess) await killDevServer();
  process.exit(1);
});
