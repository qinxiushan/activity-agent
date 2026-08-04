interface ProbeCase {
  id: string;
  message: string;
  expectedPhase: "idle" | "clarifying";
  forbiddenTools: string[];
  requiredTools?: string[];
}

const baseUrl = process.env.EVAL_SERVER ?? "http://localhost:30142";
const cwd = process.cwd();
const timeoutMs = Number(process.env.EVAL_TIMEOUT_MS ?? 180_000);

const cases: ProbeCase[] = [
  {
    id: "greeting",
    message: "你好",
    expectedPhase: "idle",
    forbiddenTools: ["intent_parse", "ask_clarification"],
  },
  {
    id: "capability-question",
    message: "你能做什么？",
    expectedPhase: "idle",
    forbiddenTools: ["intent_parse", "ask_clarification"],
  },
  {
    id: "explicit-planning-request",
    message: "帮我规划一次北京周末约会。",
    expectedPhase: "clarifying",
    forbiddenTools: [],
    requiredTools: ["classify_turn", "intent_parse", "ask_clarification"],
  },
];

async function request(pathname: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": "eval-intent-routing",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${pathname} returned ${response.status}: ${await response.text()}`);
  return response;
}

async function waitForIdle(sessionId: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const body = await request(`/api/agent/${encodeURIComponent(sessionId)}`).then((response) => response.json()) as {
      state?: { isStreaming?: boolean; isCompacting?: boolean };
    };
    if (!body.state?.isStreaming && !body.state?.isCompacting) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${sessionId} did not become idle within ${timeoutMs}ms`);
}

async function readPlanState(sessionId: string): Promise<{
  phase: string;
  clarificationCount: number;
  pendingClarification?: { questions?: Array<{ field: string }> };
}> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`${baseUrl}/api/plan-state/${encodeURIComponent(sessionId)}`, {
      headers: { "X-User-Id": "eval-intent-routing" },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return response.json();
    if (response.status !== 404) throw new Error(`plan-state returned ${response.status}: ${await response.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${sessionId} plan-state was not persisted within ${timeoutMs}ms`);
}

function toolNamesOf(messages: Array<{ role?: string; content?: unknown }>): string[] {
  return messages.flatMap((message) => Array.isArray(message.content)
    ? message.content.flatMap((block) => {
        const item = block as { type?: string; toolName?: string };
        return item.type === "toolCall" && item.toolName ? [item.toolName] : [];
      })
    : []);
}

function toolErrorsOf(messages: Array<{ role?: string; toolName?: string; isError?: boolean; content?: unknown }>) {
  return messages
    .filter((message) => message.role === "toolResult" && message.isError)
    .map((message) => ({ toolName: message.toolName, content: message.content }));
}

async function runProbe(probe: ProbeCase) {
  const startedAt = Date.now();
  const created = await request("/api/agent/new", {
    method: "POST",
    body: JSON.stringify({
      type: "prompt",
      cwd,
      message: probe.message,
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    }),
  }).then((response) => response.json()) as { sessionId?: string };
  if (!created.sessionId) throw new Error(`${probe.id}: missing sessionId`);
  const sessionId = created.sessionId;
  try {
    await waitForIdle(sessionId);
    const [state, session] = await Promise.all([
      readPlanState(sessionId),
      request(`/api/sessions/${encodeURIComponent(sessionId)}`).then((response) => response.json()) as Promise<{
        context?: { messages?: Array<{ role?: string; content?: unknown }> };
      }>,
    ]);
    const messages = session.context?.messages ?? [];
    const tools = toolNamesOf(messages);
    const toolErrors = toolErrorsOf(messages);
    const failures = [
      ...(state.phase === probe.expectedPhase ? [] : [`phase=${state.phase}, expected=${probe.expectedPhase}`]),
      ...probe.forbiddenTools.filter((tool) => tools.includes(tool)).map((tool) => `forbidden tool ${tool}`),
      ...(probe.requiredTools ?? []).filter((tool) => !tools.includes(tool)).map((tool) => `missing tool ${tool}`),
      ...(probe.id === "explicit-planning-request" && tools.filter((tool) => tool === "ask_clarification").length !== 1
        ? [`ask_clarification calls=${tools.filter((tool) => tool === "ask_clarification").length}, expected=1`]
        : []),
    ];
    return {
      id: probe.id,
      passed: failures.length === 0,
      durationMs: Date.now() - startedAt,
      phase: state.phase,
      clarificationCount: state.clarificationCount,
      questionFields: state.pendingClarification?.questions?.map((question) => question.field) ?? [],
      tools,
      toolErrors,
      failures,
    };
  } finally {
    await request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const results = [];
  for (const probe of cases) {
    const result = await runProbe(probe);
    results.push(result);
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id} ${result.durationMs}ms phase=${result.phase} tools=${result.tools.join(",")}`);
  }
  console.log(JSON.stringify({ passed: results.filter((item) => item.passed).length, total: results.length, results }, null, 2));
  if (results.some((item) => !item.passed)) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 2;
});
