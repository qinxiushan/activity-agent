import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEvalDataset } from "../lib/eval/dataset";
import { EvalHarness } from "../lib/eval/harness";
import { HttpAgentDriver } from "../lib/eval/http-agent-driver";
import type { EvalGrade, EvalRun, EvalScenario, EvalTarget } from "../lib/eval/types";

interface CliOptions {
  server: string;
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
  const repetitions = Number(value("--repetitions") ?? process.env.EVAL_REPETITIONS ?? 1);
  const limitRaw = value("--limit") ?? process.env.EVAL_LIMIT;
  const timeoutMs = Number(value("--timeout-ms") ?? process.env.EVAL_TIMEOUT_MS ?? 300_000);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    throw new Error("--repetitions must be an integer between 1 and 10");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 900_000) {
    throw new Error("--timeout-ms must be an integer between 10000 and 900000");
  }
  return {
    server: value("--server") ?? process.env.EVAL_SERVER ?? "http://localhost:30142",
    dataset: value("--dataset") ?? "evals/datasets/agent-regression-v1.json",
    repetitions,
    timeoutMs,
    limit: limitRaw ? Number(limitRaw) : undefined,
    scenarioId: value("--id"),
    output: value("--output"),
  };
}

async function discoverTarget(server: string): Promise<EvalTarget> {
  const response = await fetch(`${server}/api/models`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`/api/models returned ${response.status}`);
  const body = await response.json() as {
    defaultModel?: { provider: string; modelId: string };
    modelList?: Array<{ provider: string; id: string }>;
  };
  if (body.defaultModel) {
    return { provider: body.defaultModel.provider, modelId: body.defaultModel.modelId };
  }
  const first = body.modelList?.[0];
  if (!first) throw new Error("No configured model found");
  return { provider: first.provider, modelId: first.id };
}

function selectScenarios(all: EvalScenario[], options: CliOptions): EvalScenario[] {
  let selected = options.scenarioId
    ? all.filter((scenario) => scenario.id === options.scenarioId)
    : all;
  if (options.scenarioId && selected.length === 0) {
    throw new Error(`Unknown scenario id ${options.scenarioId}`);
  }
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);
  return selected;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(ratio * sorted.length) - 1)] ?? 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = selectScenarios(
    loadEvalDataset(path.resolve(options.dataset)),
    options,
  );
  const target = await discoverTarget(options.server);
  const results: Array<{ scenario: EvalScenario; run: EvalRun; grade: EvalGrade }> = [];
  console.log(`\n=== Eval V1 Agent Regression ===`);
  console.log(`Target: ${target.provider}/${target.modelId}`);
  console.log(`Scenarios: ${scenarios.length} × ${options.repetitions}\n`);
  console.log(`Per-turn timeout: ${options.timeoutMs}ms\n`);

  for (const scenario of scenarios) {
    for (let trial = 1; trial <= options.repetitions; trial++) {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "activity-eval-v1-"));
      const driver = new HttpAgentDriver({
        baseUrl: options.server,
        cwd,
        target,
        userId: `eval-v1-${scenario.id}-${trial}`,
        timeoutMs: options.timeoutMs,
      });
      try {
        const result = await new EvalHarness().run(scenario, driver);
        results.push({ scenario, ...result });
        console.log(
          `${result.grade.hardPassed ? "✅" : "❌"} ${scenario.id} trial ${trial}` +
          ` — ${result.grade.summary.passed}/${result.grade.checks.length}` +
          `${result.grade.failureCodes.length ? ` — ${result.grade.failureCodes.join(", ")}` : ""}`,
        );
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    }
  }

  const hardPassed = results.filter((item) => item.grade.hardPassed).length;
  const scenarioPassAll = scenarios.filter((scenario) => {
    const trials = results.filter((item) => item.scenario.id === scenario.id);
    return trials.length === options.repetitions && trials.every((item) => item.grade.hardPassed);
  }).length;
  const failureDistribution = Object.fromEntries(
    [...new Set(results.flatMap((item) => item.grade.failureCodes))].map((code) => [
      code,
      results.filter((item) => item.grade.failureCodes.includes(code)).length,
    ]),
  );
  const durations = results.map((item) => item.run.metrics.durationMs);
  const timeoutCount = results.filter((item) => item.run.events.some((event) =>
    event.type === "error" && /did not become idle|timeout|timed out/i.test(event.message ?? ""),
  )).length;
  const report = {
    schemaVersion: "eval-report-v1",
    generatedAt: new Date().toISOString(),
    dataset: path.resolve(options.dataset),
    target,
    repetitions: options.repetitions,
    timeoutMs: options.timeoutMs,
    metrics: {
      scenarioCount: scenarios.length,
      trialCount: results.length,
      hardSuccessRate: Number((hardPassed / Math.max(1, results.length)).toFixed(4)),
      passK: Number((scenarioPassAll / Math.max(1, scenarios.length)).toFixed(4)),
      averageDurationMs: Math.round(
        results.reduce((sum, item) => sum + item.run.metrics.durationMs, 0) /
        Math.max(1, results.length),
      ),
      p50DurationMs: percentile(durations, 0.5),
      p90DurationMs: percentile(durations, 0.9),
      p95DurationMs: percentile(durations, 0.95),
      maxDurationMs: Math.max(0, ...durations),
      timeoutCount,
      timeoutRate: Number((timeoutCount / Math.max(1, results.length)).toFixed(4)),
      averageToolCalls: Number((
        results.reduce((sum, item) => sum + item.run.metrics.toolCallCount, 0) /
        Math.max(1, results.length)
      ).toFixed(2)),
      failureDistribution,
    },
    results: results.map((item) => ({
      scenarioId: item.scenario.id,
      run: item.run,
      grade: item.grade,
    })),
  };
  console.log("\n" + JSON.stringify(report.metrics, null, 2));
  if (options.output) {
    await fs.mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await fs.writeFile(path.resolve(options.output), JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`Report: ${path.resolve(options.output)}`);
  }
  if (hardPassed !== results.length) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 2;
});
