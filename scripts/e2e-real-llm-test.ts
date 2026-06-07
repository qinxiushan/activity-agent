/**
 * Real LLM End-to-End Test (HTTP client)
 *
 * 验证完整的 SOP-v2 工作流（用户单次确认 + 1-次追问 + 12 工具）
 *
 * 这个测试通过 HTTP API 驱动 Next.js dev server（必须先启动）：
 *   1. 终端 1:  npm run dev                    # 启动 dev server (port 30142)
 *   2. 终端 2:  ./node_modules/.bin/tsx scripts/e2e-real-llm-test.ts
 *
 * 注意：必须用本地 tsx（已装到 devDependencies），不能用 npx tsx：
 *   - pi-coding-agent 的 exports 只有 "import" 条件（无 "require"）
 *   - npx tsx 4.x 的 CJS register 解析不到
 *   - 本地 tsx 4.22+ 在 .ts 脚本顶层 import 走 ESM 链路
 *
 * 模型发现：直接 GET /api/models，让 dev server 用 AuthStorage + SettingsManager
 *   去识别（和 Web UI 用同一份真相），不需要单独的 models.json 文件。
 *
 * 测试做的事：
 *   1. GET /api/models 拿 defaultModel（或 modelList 第一个）
 *   2. POST /api/agent/new 启动 session，发送中文 prompt（含 5 个关键字段）
 *   3. 打开 SSE 流收事件
 *   4. 轮询 /api/agent/[id] 等 isStreaming 变 false
 *   5. 断言：intent_parse / search_* / get_weather / compute_route / check_opening_hours 都调了
 *   6. 读 ~/.pi/agent/plan-states/<sessionId>.json 验证 phase = plan_confirm
 *   7. POST /api/agent/[id] 发 "确认"
 *   8. 等第二轮 idle
 *   9. 断言 phase = executing
 *  10. DELETE /api/sessions/[id] 清理
 *
 * 退出码：
 *   0  - 全部断言通过
 *   1  - 有断言失败
 *   2  - 环境/配置问题（无模型、dev server 未启动）
 *   3  - LLM 调用异常
 */

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// ============================================================================
// 配置
// ============================================================================

const SERVER_BASE = process.env.E2E_SERVER ?? "http://localhost:30142";
const PLAN_STATES_DIR = path.join(os.homedir(), ".pi", "agent", "plan-states");
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

interface ModelEntry {
  id: string;
  provider: string;
  [key: string]: unknown;
}

interface ToolCallRecord {
  name: string;
  callId: string;
  argsSummary: string;
  ok: boolean;
  resultSummary: string;
}

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); process.exitCode = 1; }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function summarizeArgs(args: unknown, maxLen = 80): string {
  try {
    const s = JSON.stringify(args);
    if (!s || s === "{}") return "{}";
    return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
  } catch { return "<unserializable>"; }
}

function summarizeResult(result: unknown, maxLen = 120): string {
  try {
    if (!result) return "<no result>";
    const r = result as { content?: Array<{ type: string; text?: string }>; details?: unknown };
    if (Array.isArray(r.content)) {
      const texts = r.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text ?? "").join(" ");
      if (texts) return texts.length > maxLen ? texts.slice(0, maxLen) + "..." : texts;
    }
    if (r.details !== undefined) {
      const s = JSON.stringify(r.details);
      return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
    }
    return JSON.stringify(result).slice(0, maxLen);
  } catch { return "<unserializable>"; }
}

async function loadModel(): Promise<ModelEntry | null> {
  try {
    const r = await fetch(`${SERVER_BASE}/api/models`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) {
      console.error(`❌ /api/models returned HTTP ${r.status}`);
      return null;
    }
    const data = await r.json() as {
      modelList?: ModelEntry[];
      defaultModel?: { provider: string; modelId: string };
    };
    if (data.defaultModel?.provider && data.defaultModel.modelId) {
      return { id: data.defaultModel.modelId, provider: data.defaultModel.provider };
    }
    const first = data.modelList?.[0];
    if (first?.provider && first.id) return first;
    console.error("❌ No model available — set defaultProvider/defaultModel in ~/.pi/agent/settings.json and a key in ~/.pi/agent/auth.json");
    return null;
  } catch (e) {
    console.error(`❌ Failed to fetch /api/models: ${(e as Error).message}`);
    return null;
  }
}

async function makeTempCwd(): Promise<string> {
  const dir = path.join(os.tmpdir(), `activity-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function checkServer(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVER_BASE}/api/sessions`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// SSE event collection
// ============================================================================

async function collectEvents(sessionId: string, onEvent: (e: Record<string, unknown>) => void): Promise<() => void> {
  const controller = new AbortController();
  const url = `${SERVER_BASE}/api/agent/${sessionId}/events`;
  (async () => {
    try {
      const r = await fetch(url, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
      if (!r.ok || !r.body) {
        console.error(`SSE: HTTP ${r.status}`);
        return;
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE: events separated by \n\n, each line "data: ..."
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const payload = dataLine.slice("data: ".length).trim();
          if (!payload) continue;
          try {
            const ev = JSON.parse(payload) as Record<string, unknown>;
            onEvent(ev);
          } catch { /* keep alive */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("SSE error:", (e as Error).message);
      }
    }
  })();
  return () => controller.abort();
}

async function waitForIdle(sessionId: string, timeoutMs: number): Promise<{ idle: boolean; elapsedMs: number }> {
  const start = Date.now();
  await sleep(500);
  let lastStreaming = true;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${SERVER_BASE}/api/agent/${sessionId}`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) {
        await sleep(500);
        continue;
      }
      const data = await r.json() as { running?: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean } };
      if (data.running && data.state) {
        lastStreaming = !!(data.state.isStreaming || data.state.isCompacting);
        if (!lastStreaming) {
          await sleep(300); // grace
          const r2 = await fetch(`${SERVER_BASE}/api/agent/${sessionId}`, { signal: AbortSignal.timeout(3000) });
          const data2 = await r2.json() as { running?: boolean; state?: { isStreaming?: boolean; isCompacting?: boolean } };
          if (data2.running && data2.state && !data2.state.isStreaming && !data2.state.isCompacting) {
            return { idle: true, elapsedMs: Date.now() - start };
          }
        }
      } else if (!data.running) {
        // session died, count as idle
        return { idle: true, elapsedMs: Date.now() - start };
      }
    } catch { /* network blip, retry */ }
    await sleep(500);
  }
  return { idle: false, elapsedMs: Date.now() - start };
}

interface PlanState {
  sessionId: string;
  phase: string;
  turnCount: number;
  clarificationCount: number;
  intent: Record<string, unknown>;
  plan: { summary: string; timeline: unknown[]; totalCost: number; totalDurationMinutes: number; weather: unknown } | null;
  history: Array<{ phase: string; at: number; reason?: string }>;
}

async function readPlanState(sessionId: string): Promise<PlanState | null> {
  const file = path.join(PLAN_STATES_DIR, `${sessionId}.json`);
  if (!existsSync(file)) return null;
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw) as PlanState;
  } catch {
    return null;
  }
}

async function readPlanStateStable(
  sessionId: string,
  timeoutMs: number,
): Promise<{ state: PlanState | null; samples: Array<{ phase: string; turnCount: number; at: number }> }> {
  const start = Date.now();
  const samples: Array<{ phase: string; turnCount: number; at: number }> = [];
  let lastState: PlanState | null = null;
  let lastChange = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await readPlanState(sessionId);
    if (s) {
      samples.push({ phase: s.phase, turnCount: s.turnCount, at: Date.now() - start });
      const sig = `${s.phase}:${s.turnCount}`;
      const lastSig = lastState ? `${lastState.phase}:${lastState.turnCount}` : "";
      if (sig !== lastSig) lastChange = Date.now();
      lastState = s;
    }
    if (Date.now() - lastChange >= 500) return { state: lastState, samples };
    await sleep(150);
  }
  return { state: lastState, samples };
}

async function sessionFileExists(sessionId: string): Promise<boolean> {
  // walk SESSIONS_DIR recursively (cwd-encoded dirs)
  async function walk(dir: string): Promise<boolean> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch { return false; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (await walk(p)) return true;
      } else if (e.name.startsWith(sessionId) || e.name.includes(sessionId)) {
        return true;
      }
    }
    return false;
  }
  return walk(SESSIONS_DIR);
}

// ============================================================================
// 主流程
// ============================================================================

async function main(): Promise<void> {
  console.log("\n=== Real LLM E2E (SOP-v2) — HTTP mode ===\n");

  // ─── 预检 ───────────────────────────────────────────────
  section("🔧 Pre-flight");

  const model = await loadModel();
  if (!model) {
    console.error("💥 No model available. Configure ~/.pi/agent/settings.json (defaultProvider/defaultModel) and ~/.pi/agent/auth.json (key)");
    process.exit(2);
  }
  ok("model discovered via /api/models", true, `${model.provider}/${model.id}`);

  if (!(await checkServer())) {
    console.error(`💥 Dev server not reachable at ${SERVER_BASE}. Start it with: npm run dev`);
    process.exit(2);
  }
  ok("dev server reachable", true, SERVER_BASE);

  const tempCwd = await makeTempCwd();
  ok("temp cwd created", existsSync(tempCwd), tempCwd);

  section("👥 userId 隔离 (v2)");
  const aliceId = `e2e-alice-${Date.now()}`;
  const bobId = `e2e-bob-${Date.now()}`;

  const aliceInit = await fetch(`${SERVER_BASE}/api/user-preferences?userId=${aliceId}`).then((r) => r.json()) as { preferences: { defaults: Record<string, unknown> } };
  ok("alice initial: empty defaults", Object.keys(aliceInit.preferences.defaults).length === 0, aliceId);

  const alicePutRes = await fetch(`${SERVER_BASE}/api/user-preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: aliceId, defaults: { partySize: 4, budgetPerPerson: 1000 } }),
  });
  ok("alice PUT defaults", alicePutRes.ok);

  const aliceRead = await fetch(`${SERVER_BASE}/api/user-preferences?userId=${aliceId}`).then((r) => r.json()) as { preferences: { defaults: { partySize?: number; budgetPerPerson?: number } } };
  ok("alice reads back partySize=4", aliceRead.preferences.defaults.partySize === 4);
  ok("alice reads back budget=1000", aliceRead.preferences.defaults.budgetPerPerson === 1000);

  const bobRead = await fetch(`${SERVER_BASE}/api/user-preferences?userId=${bobId}`).then((r) => r.json()) as { preferences: { defaults: Record<string, unknown> } };
  ok("bob isolated: empty defaults (didn't see alice's data)", Object.keys(bobRead.preferences.defaults).length === 0);

  const aliceResetRes = await fetch(`${SERVER_BASE}/api/user-preferences`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: aliceId, action: "reset" }),
  });
  ok("alice reset ok", aliceResetRes.ok);

  const aliceAfterReset = await fetch(`${SERVER_BASE}/api/user-preferences?userId=${aliceId}`).then((r) => r.json()) as { preferences: { defaults: Record<string, unknown> } };
  ok("alice after reset: empty", Object.keys(aliceAfterReset.preferences.defaults).length === 0);

  const bobFinal = await fetch(`${SERVER_BASE}/api/user-preferences?userId=${bobId}`).then((r) => r.json()) as { preferences: { defaults: Record<string, unknown> } };
  ok("bob still isolated after alice reset", Object.keys(bobFinal.preferences.defaults).length === 0);

  let currentTurn = 1;

  const turns: ToolCallRecord[][] = [[]];
  const assistantTexts: string[] = [];
  let sseStop: (() => void) | null = null;
  const setTurn = (i: number): void => { while (turns.length <= i) turns.push([]); };

  // 步骤 1: 创建 session + 发初始 prompt
  const userPrompt = [
    "想和女朋友周六(2026-07-11)去玩",
    "下午6点前要结束(10:00开始)",
    "人在三里屯(北京朝阳)",
    "预算300元/人",
  ].join("，");

  console.log(`  User: ${userPrompt}`);

  const createRes = await fetch(`${SERVER_BASE}/api/agent/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "prompt",
      cwd: tempCwd,
      message: userPrompt,
      provider: model.provider,
      modelId: model.id,
    }),
  });
  if (!createRes.ok) {
    console.error(`💥 Failed to create session: ${createRes.status} ${await createRes.text()}`);
    process.exit(3);
  }
  const createData = await createRes.json() as { sessionId: string };
  const sessionId = createData.sessionId;
  ok("session created", !!sessionId, `id=${sessionId.slice(0, 8)}`);

  // 开始收 SSE 事件
  sseStop = await collectEvents(sessionId, (ev) => {
    const type = ev.type as string;
    switch (type) {
      case "tool_execution_start": {
        const name = (ev.toolName as string) ?? "?";
        const callId = (ev.toolCallId as string) ?? "?";
        const args = ev.args;
        setTurn(currentTurn);
        turns[currentTurn - 1]!.push({ name, callId, argsSummary: summarizeArgs(args), ok: true, resultSummary: "" });
        break;
      }
      case "tool_execution_end": {
        const callId = (ev.toolCallId as string) ?? "?";
        const result = ev.result;
        const isError = ev.isError === true;
        for (const arr of turns) {
          const idx = arr.findIndex((t) => t.callId === callId && !t.resultSummary);
          if (idx !== -1) {
            arr[idx]!.ok = !isError;
            arr[idx]!.resultSummary = summarizeResult(result);
            break;
          }
        }
        break;
      }
      case "message_end": {
        const msg = ev.message as { role?: string; content?: Array<{ type: string; text?: string }> } | undefined;
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          const text = msg.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text ?? "").join("");
          if (text) assistantTexts.push(text);
        }
        break;
      }
    }
  });

  // 等 LLM 完成第一轮
  const wait1 = await waitForIdle(sessionId, 180_000);
  ok("LLM finished first turn (within 180s)", wait1.idle, `${Math.round(wait1.elapsedMs / 1000)}s`);

  // ─── 步骤 2: 断言第一轮 ────────────────────────────────
  section("🧪 Step 2: Assert first turn");

  if (!wait1.idle) {
    console.error("💥 LLM did not finish first turn.");
    sseStop?.();
    await cleanup(sessionId);
    process.exit(3);
  }

  const intentCalled = turns[0]!.some((t) => t.name === "intent_parse");
  ok("intent_parse was called (turn 1)", intentCalled);

  const searchCalled = turns[0]!.some((t) => t.name === "search_activities" || t.name === "search_restaurants");
  ok("search_activities or search_restaurants was called (turn 1)", searchCalled);

  ok("get_weather was called in turn 1 (SOP variable)", turns[0]!.some((t) => t.name === "get_weather"));
  ok("compute_route was called in turn 1 (SOP variable)", turns[0]!.some((t) => t.name === "compute_route"));
  ok("check_opening_hours was called in turn 1 (SOP variable)", turns[0]!.some((t) => t.name === "check_opening_hours"));

  const noPrematureBooking = !turns[0]!.some((t) => t.name === "reservation_exec");
  ok("no premature reservation_exec in turn 1", noPrematureBooking);

  // 稳定读取 plan state 验证 phase（轮询直到 phase/turnCount 500ms 不变）
  const stable1 = await readPlanStateStable(sessionId, 8_000);
  if (stable1.samples.length > 0) {
    console.log(`  Plan state samples (turn 1): ${stable1.samples.map((s) => `${s.phase}@${s.turnCount}`).join(" → ")}`);
  }
  const state1 = stable1.state;
  if (!state1) {
    ok("plan state file exists", false, `${PLAN_STATES_DIR}/${sessionId}.json`);
  } else {
    ok("plan state file exists", true, `phase=${state1.phase}, turnCount=${state1.turnCount}`);
    ok("final phase after LLM turn = plan_confirm", state1.phase === "plan_confirm", `actual=${state1.phase}`);
    ok("intent captured (date)", !!state1.intent.date, String(state1.intent.date));
    ok("intent captured (startTime)", !!state1.intent.startTime, String(state1.intent.startTime));
    ok("intent captured (departurePoint)", !!state1.intent.departurePoint, JSON.stringify(state1.intent.departurePoint));
    ok("intent captured (partySize)", state1.intent.partySize !== undefined, String(state1.intent.partySize));
    ok("intent captured (budgetPerPerson)", state1.intent.budgetPerPerson !== undefined, String(state1.intent.budgetPerPerson));
  }

  // ─── 步骤 3: 发 "确认" ────────────────────────────────
  section("✅ Step 3: Send confirmation");

  const beforeConfirm = state1?.phase ?? "?";
  console.log(`  Phase before confirm: ${beforeConfirm}`);

  const confirmRes = await fetch(`${SERVER_BASE}/api/agent/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: "确认" }),
  });
  if (!confirmRes.ok) {
    console.error(`💥 Failed to send confirm: ${confirmRes.status} ${await confirmRes.text()}`);
    sseStop?.();
    await cleanup(sessionId);
    process.exit(3);
  }
  ok("'确认' sent", true);
  currentTurn = 2;

  const wait2 = await waitForIdle(sessionId, 120_000);
  ok("LLM finished confirm turn (within 120s)", wait2.idle, `${Math.round(wait2.elapsedMs / 1000)}s`);

  // ─── 步骤 4: 断言第二轮 ────────────────────────────────
  section("🧪 Step 4: Assert confirm turn");

  if (!wait2.idle) {
    console.error("💥 LLM did not finish confirm turn.");
    sseStop?.();
    await cleanup(sessionId);
    process.exit(3);
  }

  const state2 = await readPlanStateStable(sessionId, 8_000);
  if (state2.samples.length > 0) {
    console.log(`  Plan state samples (turn 2): ${state2.samples.map((s) => `${s.phase}@${s.turnCount}`).join(" → ")}`);
  }
  const s2 = state2.state;
  if (!s2) {
    ok("plan state exists after confirm", false);
  } else {
    ok("phase transitioned to executing after confirm", s2.phase === "executing", `actual=${s2.phase}`);
  }

  ok("reservation_exec was called in turn 2 (bookings start)", turns[1] ? turns[1]!.some((t) => t.name === "reservation_exec") : false);

  // ─── 打印结果 ─────────────────────────────────────────
  section("📊 Trace");

  console.log(`\n  Plan state history:`);
  if (s2?.history) {
    for (const h of s2.history) {
      console.log(`    → ${h.phase}${h.reason ? ` (${h.reason})` : ""}`);
    }
  }

  for (let i = 0; i < turns.length; i++) {
    const tcs = turns[i]!;
    console.log(`\n  Tool calls turn ${i + 1} (${tcs.length}):`);
    for (const t of tcs) {
      const icon = t.ok ? "✓" : "✗";
      console.log(`    [${icon}] ${t.name}  args=${t.argsSummary}  →  ${t.resultSummary}`);
    }
  }

  console.log(`\n  Assistant text snippets (${assistantTexts.length}):`);
  for (const t of assistantTexts) {
    const oneline = t.replace(/\s+/g, " ").trim();
    console.log(`    > ${oneline.length > 200 ? oneline.slice(0, 200) + "..." : oneline}`);
  }

  if (s2) {
    console.log(`\n  Captured intent:`);
    console.log(`    ${JSON.stringify(s2.intent, null, 2).split("\n").join("\n    ")}`);
    if (s2.plan) {
      console.log(`\n  Captured plan summary:`);
      console.log(`    ${s2.plan.summary}`);
      console.log(`    timeline: ${s2.plan.timeline.length} legs, total ${s2.plan.totalDurationMinutes}min, ¥${s2.plan.totalCost}`);
    } else {
      console.log(`\n  Captured plan: <none>`);
    }
  }

  // ─── 清理 ──────────────────────────────────────────────
  section("🧹 Cleanup");
  sseStop?.();
  await cleanup(sessionId);
  ok("session cleaned up", !(await sessionFileExists(sessionId)));

  // 删除 temp cwd
  try {
    await fs.rm(tempCwd, { recursive: true, force: true });
    ok("temp cwd removed", !existsSync(tempCwd));
  } catch (e) {
    ok("temp cwd removed", false, (e as Error).message);
  }

  // ─── 总结 ──────────────────────────────────────────────
  console.log("\n=== Summary ===");
  console.log(`  Model: ${model.provider}/${model.id}`);
  console.log(`  Session: ${sessionId}`);
  console.log(`  Pass: ${pass}`);
  console.log(`  Fail: ${fail}`);
  console.log(`  Tool calls: ${turns.flat().length} (turn 1: ${turns[0]?.length ?? 0}, turn 2: ${turns[1]?.length ?? 0})`);
  console.log(`  Exit code: ${process.exitCode ?? 0}`);
  console.log("=== Done ===\n");
}

async function cleanup(sessionId: string): Promise<void> {
  try {
    await fetch(`${SERVER_BASE}/api/sessions/${sessionId}`, { method: "DELETE" });
  } catch { /* best effort */ }
}

main().catch((e) => {
  console.error("💥 E2E test crashed:", e);
  process.exit(3);
});
