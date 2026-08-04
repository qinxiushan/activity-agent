import path from "node:path";
import { EvalHarness } from "../lib/eval/harness";
import { loadEvalDataset } from "../lib/eval/dataset";
import { gradeEvalRun } from "../lib/eval/graders";
import { ReplayDataProvider, type ReplayFixture } from "../lib/eval/replay-provider";
import { MockDataProvider } from "../lib/mock-data-provider";
import type {
  EvalAgentCommand,
  EvalAgentDriver,
  EvalAgentTurn,
  EvalRun,
  EvalScenario,
  EvalStateSnapshot,
  EvalTarget,
  EvalTraceEvent,
} from "../lib/eval/types";

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const budget = {
  currency: "CNY" as const,
  partySize: 2,
  budgetPerPerson: 300,
  budgetLimit: 600,
  knownTotal: 300,
  estimatedTotal: 200,
  reserveTotal: 50,
  minimumTotal: 400,
  likelyTotal: 550,
  maximumTotal: 650,
  projectedTotal: 550,
  projectedPerPerson: 275,
  remaining: 50,
  status: "within" as const,
  completeness: 0.8,
  unknownPriceCount: 1,
  reserveStrategy: "balanced" as const,
  assumptions: ["test fixture"],
  items: [],
};

function plan() {
  return {
    summary: "Eval V1 test plan",
    timeline: [
      { startTime: "10:00", endTime: "10:15", type: "departure" as const },
      { startTime: "10:15", endTime: "11:30", type: "activity" as const, poiId: "poi-1" },
    ],
    totalCost: 550,
    totalDurationMinutes: 90,
    weather: {
      city: "北京", date: "2026-08-01", condition: "晴",
      tempMax: 30, tempMin: 22, advice: "test",
    },
    warnings: [],
    budgetBreakdown: budget,
  };
}

function orderedTools(scenario: EvalScenario): string[] {
  const names = new Set([
    ...(scenario.oracle.requiredTools ?? []),
    ...(scenario.oracle.requiredToolGroups ?? []).map((group) => group.anyOf[0]!),
  ]);
  const result: string[] = [];
  while (names.size > 0) {
    const next = [...names].find((name) =>
      (scenario.oracle.toolOrder ?? []).every((rule) =>
        rule.after !== name || !names.has(rule.before) || result.includes(rule.before)));
    if (!next) throw new Error(`Cycle in tool order for ${scenario.id}`);
    result.push(next);
    names.delete(next);
  }
  return result;
}

function passingRun(scenario: EvalScenario): EvalRun {
  const events: EvalTraceEvent[] = [];
  let sequence = 0;
  const toolNames = orderedTools(scenario);
  if (scenario.oracle.requireConfirmationBeforeCommit && toolNames.includes("commit_itinerary")) {
    const commitIndex = toolNames.indexOf("commit_itinerary");
    events.push({
      sequence: ++sequence,
      at: new Date().toISOString(),
      type: "user_message",
      detail: { commandType: "confirm_plan" },
    });
    if (commitIndex < 0) throw new Error("unreachable");
  }
  for (const toolName of toolNames) {
    events.push({
      sequence: ++sequence,
      at: new Date().toISOString(),
      type: "tool_end",
      toolName,
      ok: true,
      result: toolName === "validate_itinerary" ? { warnings: [] } : {},
    });
  }
  return {
    runId: `synthetic-${scenario.id}`,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    target: { provider: "synthetic", modelId: "contract" },
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    events,
    finalState: {
      phase: scenario.oracle.expectedFinalPhases[0]!,
      turnCount: 1,
      clarificationCount: Math.min(1, scenario.oracle.maxClarifications ?? 1),
      intent: scenario.oracle.requiredIntent
        ? structuredClone(scenario.oracle.requiredIntent)
        : undefined,
      plan: scenario.oracle.planRequired ? plan() : undefined,
    },
    metrics: { durationMs: 1, toolCallCount: toolNames.length, errorCount: 0 },
  };
}

class FakeDriver implements EvalAgentDriver {
  readonly target: EvalTarget = { provider: "fake", modelId: "deterministic" };
  private confirmed = false;
  async start(): Promise<EvalAgentTurn> {
    return this.turn("plan_confirm", ["submit_plan"]);
  }
  async send(command: EvalAgentCommand): Promise<EvalAgentTurn> {
    if (command.type === "confirm_plan") this.confirmed = true;
    return this.turn(this.confirmed ? "completed" : "plan_confirm", ["commit_itinerary", "plan_save"]);
  }
  async close(): Promise<void> {}
  private turn(phase: EvalStateSnapshot["phase"], tools: string[]): EvalAgentTurn {
    return {
      events: tools.flatMap((toolName) => [
        { at: new Date().toISOString(), type: "tool_start" as const, toolName, toolCallId: toolName },
        { at: new Date().toISOString(), type: "tool_end" as const, toolName, toolCallId: toolName, ok: true },
      ]),
      state: {
        phase,
        turnCount: this.confirmed ? 2 : 1,
        clarificationCount: 0,
        intent: { date: "2026-08-01" },
        plan: plan(),
      },
    };
  }
}

async function main(): Promise<void> {
  console.log("\n=== Eval V1 Contract Test ===\n");
  const dataset = loadEvalDataset(path.resolve("evals/datasets/agent-regression-v1.json"));
  ok("dataset has 20 scenarios", dataset.length === 20, String(dataset.length));
  ok("scenario ids are unique", new Set(dataset.map((item) => item.id)).size === dataset.length);
  ok("all scenarios declare fixture", dataset.every((item) => item.environment.fixtureId === "mock-v1"));
  ok("dataset covers complete flows", dataset.some((item) => item.tags.includes("complete")));
  ok("dataset covers clarification flows", dataset.some((item) => item.tags.includes("clarification")));
  ok("dataset covers confirmation flows", dataset.some((item) => item.tags.includes("confirmation")));
  ok("dataset covers historical regressions", dataset.some((item) => item.tags.includes("historical_regression")));

  const fixture: ReplayFixture = {
    version: "eval-replay-v1",
    id: "contract",
    providerKind: "mock",
    strictRequests: true,
    operations: {
      geocode: [{
        request: { address: "三里屯", city: "北京" },
        response: {
          name: "三里屯", city: "北京", lng: 116.45, lat: 39.93,
          coordinateSystem: "GCJ-02", source: "mock",
        },
      }],
      getWeather: [{ error: "injected weather timeout" }],
    },
  };
  const replay = new ReplayDataProvider(fixture);
  const geo = await replay.geocode("三里屯", "北京");
  ok("replay returns recorded response", geo.lng === 116.45 && geo.source === "mock");
  ok("replay consumes records", replay.remaining("geocode") === 0);
  let injectedError = "";
  try { await replay.getWeather("北京", "2026-08-01"); } catch (error) {
    injectedError = (error as Error).message;
  }
  ok("replay injects recorded errors", injectedError === "injected weather timeout");

  const fallbackReplay = new ReplayDataProvider({
    version: "eval-replay-v1",
    id: "fallback",
    providerKind: "mock",
    onMissing: "fallback",
    operations: {},
  }, new MockDataProvider());
  ok("replay can use explicit deterministic fallback",
    (await fallbackReplay.geocode("北京", "北京")).source === "mock");

  for (const scenario of dataset) {
    const grade = gradeEvalRun(scenario, passingRun(scenario));
    ok(`oracle is satisfiable: ${scenario.id}`, grade.hardPassed,
      grade.failureCodes.join(", "));
  }

  const shanghaiScenario = dataset.find((item) => item.id === "complete-shanghai-friends")!;
  const cityPrefixedRun = passingRun(shanghaiScenario);
  cityPrefixedRun.finalState!.intent!.departurePoint = {
    name: "上海人民广场",
    city: "上海市",
  };
  ok("intent matcher accepts a same-city place prefix",
    gradeEvalRun(shanghaiScenario, cityPrefixedRun).hardPassed);
  const wrongCityRun = structuredClone(cityPrefixedRun);
  wrongCityRun.finalState!.intent!.departurePoint = {
    name: "北京人民广场",
    city: "北京",
  };
  ok("intent matcher rejects the same place name in another city",
    gradeEvalRun(shanghaiScenario, wrongCityRun).failureCodes.includes("OUTCOME_REQUIRED_INTENT"));
  const differentPlaceRun = structuredClone(cityPrefixedRun);
  differentPlaceRun.finalState!.intent!.departurePoint = {
    name: "上海科技馆",
    city: "上海",
  };
  ok("intent matcher rejects a different place in the same city",
    gradeEvalRun(shanghaiScenario, differentPlaceRun).failureCodes.includes("OUTCOME_REQUIRED_INTENT"));

  const dietaryScenario = dataset.find((item) => item.id === "complete-dietary")!;
  const semanticDietaryRun = passingRun(dietaryScenario);
  semanticDietaryRun.finalState!.intent!.dietaryRestrictions = ["vegetarian"];
  ok("intent matcher normalizes Chinese and English dietary aliases",
    gradeEvalRun(dietaryScenario, semanticDietaryRun).hardPassed);
  semanticDietaryRun.finalState!.intent!.dietaryRestrictions = ["vegan"];
  ok("intent matcher keeps vegetarian and vegan semantically distinct",
    gradeEvalRun(dietaryScenario, semanticDietaryRun).failureCodes.includes("OUTCOME_REQUIRED_INTENT"));

  const recoverableSubmitRun = passingRun(dataset[0]!);
  const successfulSubmit = recoverableSubmitRun.events.find((event) =>
    event.type === "tool_end" && event.toolName === "submit_plan")!;
  recoverableSubmitRun.events.splice(recoverableSubmitRun.events.indexOf(successfulSubmit), 0, {
    sequence: successfulSubmit.sequence,
    at: new Date().toISOString(),
    type: "tool_end",
    toolName: "submit_plan",
    ok: true,
    result: { error: true, code: "BUDGET_TOKEN_INVALID" },
  });
  recoverableSubmitRun.events.forEach((event, index) => { event.sequence = index + 1; });
  ok("trajectory counts successful submissions rather than recoverable attempts",
    gradeEvalRun(dataset[0]!, recoverableSubmitRun).hardPassed);

  const harnessScenario: EvalScenario = {
    id: "harness-confirm",
    version: "1",
    description: "Harness drives structured confirmation",
    tags: ["contract"],
    user: {
      initialMessage: "test",
      steps: [{
        id: "confirm",
        trigger: { kind: "phase", phase: "plan_confirm" },
        action: { type: "confirm_plan" },
        once: true,
      }],
    },
    environment: { fixtureId: "contract" },
    oracle: {
      expectedFinalPhases: ["completed"],
      planRequired: true,
      requiredTools: ["submit_plan", "commit_itinerary", "plan_save"],
      toolOrder: [
        { before: "submit_plan", after: "commit_itinerary" },
        { before: "commit_itinerary", after: "plan_save" },
      ],
      requireConfirmationBeforeCommit: true,
    },
  };
  const harnessResult = await new EvalHarness().run(harnessScenario, new FakeDriver());
  ok("harness reaches completed", harnessResult.run.finalState?.phase === "completed");
  ok("harness records structured confirmation",
    harnessResult.run.events.some((event) =>
      event.type === "user_message" && event.detail?.commandType === "confirm_plan"));
  ok("harness output passes deterministic graders", harnessResult.grade.hardPassed,
    harnessResult.grade.failureCodes.join(", "));
  ok("trace sequence is contiguous",
    harnessResult.run.events.every((event, index) => event.sequence === index + 1));

  const failing = passingRun(dataset[0]!);
  failing.events = failing.events.filter((event) => event.toolName !== "submit_plan");
  const failedGrade = gradeEvalRun(dataset[0]!, failing);
  ok("missing required tool fails hard gate", !failedGrade.hardPassed);
  ok("failure code identifies submit_plan",
    failedGrade.failureCodes.includes("TRAJECTORY_REQUIRED_TOOL:submit_plan"));

  console.log(`\n=== Summary ===\n  Pass: ${pass}\n  Fail: ${fail}\n  Exit code: ${fail === 0 ? 0 : 1}\n`);
  if (fail > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 2;
});
