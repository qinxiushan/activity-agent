import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEvalDataset } from "../lib/eval/dataset";
import { EvalHarness } from "../lib/eval/harness";
import { HttpAgentDriver } from "../lib/eval/http-agent-driver";
import { buildPairedControlReport, type PairedControlSample } from "../lib/eval/paired-metrics";
import type { EvalScenario, EvalTarget } from "../lib/eval/types";
import type { WorkflowControlDescriptor, WorkflowControlVariant } from "../lib/workflow-control/types";

interface CliOptions {
  loopServer: string;
  fsmServer: string;
  dataset: string;
  repetitions: number;
  timeoutMs: number;
  limit?: number;
  scenarioId?: string;
  output?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const repetitions = Number(value("--repetitions") ?? process.env.EVAL_REPETITIONS ?? 3);
  const timeoutMs = Number(value("--timeout-ms") ?? process.env.EVAL_TIMEOUT_MS ?? 300_000);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) {
    throw new Error("--repetitions must be an integer between 1 and 20");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 900_000) {
    throw new Error("--timeout-ms must be an integer between 10000 and 900000");
  }
  const limitRaw = value("--limit") ?? process.env.EVAL_LIMIT;
  return {
    loopServer: value("--loop-server") ?? process.env.EVAL_LOOP_SERVER ?? "http://localhost:30143",
    fsmServer: value("--fsm-server") ?? process.env.EVAL_FSM_SERVER ?? "http://localhost:30142",
    dataset: value("--dataset") ?? "evals/datasets/agent-regression-v1.json",
    repetitions,
    timeoutMs,
    limit: limitRaw ? Number(limitRaw) : undefined,
    scenarioId: value("--id"),
    output: value("--output"),
  };
}

async function getJson<T>(server: string, pathname: string): Promise<T> {
  const url = `${server}${pathname}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error
      ? ` (${error.cause.message})`
      : "";
    throw new Error(
      `Cannot reach ${url}${cause}. Start the phase-gated server with ` +
      `"npm run dev" and the isolated loop server with "npm run dev:eval:loop".`,
      { cause: error },
    );
  }
  if (!response.ok) throw new Error(`${server}${pathname} returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function discoverTarget(server: string): Promise<EvalTarget> {
  const body = await getJson<{
    defaultModel?: { provider: string; modelId: string };
    modelList?: Array<{ provider: string; id: string }>;
  }>(server, "/api/models");
  if (body.defaultModel) return body.defaultModel;
  const first = body.modelList?.[0];
  if (!first) throw new Error(`No configured model found at ${server}`);
  return { provider: first.provider, modelId: first.id };
}

async function readVariant(server: string, expected: WorkflowControlVariant): Promise<WorkflowControlDescriptor> {
  const descriptor = await getJson<WorkflowControlDescriptor>(server, "/api/eval/control-variant");
  if (descriptor.variant !== expected) {
    throw new Error(`${server} is ${descriptor.variant}; expected ${expected}`);
  }
  if (!descriptor.promptHash || !descriptor.toolContractHash) {
    throw new Error(`${server} did not expose prompt/tool fingerprints`);
  }
  return descriptor;
}

function observableScenario(source: EvalScenario): EvalScenario {
  const scenario = structuredClone(source);
  for (const step of scenario.user.steps ?? []) {
    if (step.trigger.kind !== "phase") continue;
    const phase = step.trigger.phase;
    if (phase === "clarifying") step.trigger = { kind: "clarification_available" };
    if (phase === "plan_confirm") step.trigger = { kind: "plan_available" };
  }
  return scenario;
}

function selectScenarios(all: EvalScenario[], options: CliOptions): EvalScenario[] {
  let selected = options.scenarioId
    ? all.filter((scenario) => scenario.id === options.scenarioId)
    : all;
  if (options.scenarioId && selected.length === 0) throw new Error(`Unknown scenario id ${options.scenarioId}`);
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);
  return selected.map(observableScenario);
}

async function runOne(
  scenario: EvalScenario,
  trial: number,
  variant: "loop" | "fsm",
  server: string,
  target: EvalTarget,
  timeoutMs: number,
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `activity-eval-ab-${variant}-`));
  try {
    return await new EvalHarness().run(scenario, new HttpAgentDriver({
      baseUrl: server,
      cwd,
      target,
      userId: `eval-ab-${variant}-${scenario.id}-${trial}`,
      timeoutMs,
    }));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [loopControl, fsmControl] = await Promise.all([
    readVariant(options.loopServer, "observe_only"),
    readVariant(options.fsmServer, "phase_gated"),
  ]);
  if (loopControl.promptHash !== fsmControl.promptHash ||
      loopControl.toolContractHash !== fsmControl.toolContractHash) {
    throw new Error("A/B servers do not use identical prompt and tool contracts");
  }
  const [loopTarget, fsmTarget] = await Promise.all([
    discoverTarget(options.loopServer),
    discoverTarget(options.fsmServer),
  ]);
  if (loopTarget.provider !== fsmTarget.provider || loopTarget.modelId !== fsmTarget.modelId) {
    throw new Error(
      `Targets differ: loop=${loopTarget.provider}/${loopTarget.modelId}, ` +
      `fsm=${fsmTarget.provider}/${fsmTarget.modelId}`,
    );
  }
  const scenarios = selectScenarios(loadEvalDataset(path.resolve(options.dataset)), options);
  const samples: PairedControlSample[] = [];
  console.log("\n=== Agent Control A/B (paired) ===");
  console.log(`Target: ${fsmTarget.provider}/${fsmTarget.modelId}`);
  console.log(`Scenarios: ${scenarios.length} × ${options.repetitions} paired trials\n`);

  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex++) {
    const scenario = scenarios[scenarioIndex]!;
    for (let trial = 1; trial <= options.repetitions; trial++) {
      const loopFirst = (scenarioIndex + trial) % 2 === 1;
      const order = loopFirst ? ["loop", "fsm"] as const : ["fsm", "loop"] as const;
      const completed: Partial<Record<"loop" | "fsm", Awaited<ReturnType<typeof runOne>>>> = {};
      for (const variant of order) {
        const server = variant === "loop" ? options.loopServer : options.fsmServer;
        const target = variant === "loop" ? loopTarget : fsmTarget;
        completed[variant] = await runOne(scenario, trial, variant, server, target, options.timeoutMs);
      }
      samples.push({
        scenarioId: scenario.id,
        trial,
        loop: completed.loop!,
        fsm: completed.fsm!,
      });
      console.log(
        `${scenario.id} trial ${trial} (${order.join("→")}): ` +
        `loop=${completed.loop!.grade.hardPassed ? "PASS" : "FAIL"}, ` +
        `fsm=${completed.fsm!.grade.hardPassed ? "PASS" : "FAIL"}`,
      );
    }
  }

  const metrics = buildPairedControlReport(samples);
  const report = {
    ...metrics,
    dataset: path.resolve(options.dataset),
    target: fsmTarget,
    repetitions: options.repetitions,
    timeoutMs: options.timeoutMs,
    rawPairs: samples,
  };
  console.log("\n" + JSON.stringify({ variants: report.variants, paired: report.paired }, null, 2));
  if (options.output) {
    const output = path.resolve(options.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`Report: ${output}`);
  }
  if (samples.some((sample) => !sample.fsm.grade.hardPassed)) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 2;
});
