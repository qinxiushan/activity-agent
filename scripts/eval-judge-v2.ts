import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { calibratePreferenceJudge } from "../lib/eval/preference-calibration";
import { loadPreferenceDataset } from "../lib/eval/preference-dataset";
import {
  buildJudgePrompt,
  JUDGE_SYSTEM_PROMPT,
  judgeWithPositionDebias,
  parseJudgeVerdict,
} from "../lib/eval/pairwise-judge";
import type {
  DebiasedJudgeResult,
  JudgeVerdict,
  PairwiseJudge,
  PairwiseJudgeInput,
  PreferenceExample,
} from "../lib/eval/preference-types";

interface CliOptions {
  dataset: string;
  provider: string;
  modelId: string;
  limit?: number;
  output?: string;
  strict: boolean;
  minGold: number;
}

function value(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function readDefaultTarget(): Promise<{ provider?: string; modelId?: string }> {
  try {
    const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    return { provider: settings.defaultProvider, modelId: settings.defaultModel };
  } catch {
    return {};
  }
}

async function parseArgs(argv: string[]): Promise<CliOptions> {
  const defaults = await readDefaultTarget();
  const provider = value(argv, "--provider") ?? process.env.EVAL_JUDGE_PROVIDER ?? defaults.provider;
  const modelId = value(argv, "--model") ?? process.env.EVAL_JUDGE_MODEL ?? defaults.modelId;
  if (!provider || !modelId) {
    throw new Error("Judge target missing: pass --provider and --model or configure settings.json");
  }
  const limitRaw = value(argv, "--limit");
  const minGold = Number(value(argv, "--min-gold") ?? 10);
  if (!Number.isInteger(minGold) || minGold < 1) throw new Error("--min-gold must be positive");
  return {
    dataset: path.resolve(
      value(argv, "--dataset") ?? "evals/datasets/preference-seed-v2.json",
    ),
    provider,
    modelId,
    limit: limitRaw ? Number(limitRaw) : undefined,
    output: value(argv, "--output"),
    strict: argv.includes("--strict"),
    minGold,
  };
}

class ProcessPairwiseJudge implements PairwiseJudge {
  readonly id: string;
  private readonly workerPath = path.resolve("scripts/eval/pi-judge-worker.mjs");

  constructor(
    private readonly provider: string,
    private readonly modelId: string,
    private readonly timeoutMs = 90_000,
  ) {
    this.id = `pi-process:${provider}/${modelId}`;
  }

  judge(input: PairwiseJudgeInput): Promise<JudgeVerdict> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [this.workerPath, this.provider, this.modelId], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Judge worker timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const response = JSON.parse(stdout) as { ok: boolean; text?: string; error?: string };
          if (code !== 0 || !response.ok || !response.text) {
            reject(new Error(response.error ?? stderr.trim() ?? `Judge worker exited ${code}`));
            return;
          }
          resolve(parseJudgeVerdict(response.text));
        } catch (error) {
          reject(new Error(
            `Invalid judge worker response: ${error instanceof Error ? error.message : String(error)}`,
          ));
        }
      });
      child.stdin.end(JSON.stringify({
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        prompt: buildJudgePrompt(input),
      }));
    });
  }
}

function seedReferenceAgreement(
  examples: PreferenceExample[],
  results: DebiasedJudgeResult[],
): number {
  const resultById = new Map(results.map((result) => [result.exampleId, result]));
  const comparable = examples.filter((example) => {
    const result = resultById.get(example.id);
    return example.annotation.status === "seed" && result?.finalWinner !== "abstain";
  });
  if (comparable.length === 0) return 0;
  const agreed = comparable.filter((example) =>
    resultById.get(example.id)?.finalWinner === example.annotation.label).length;
  return Number((agreed / comparable.length).toFixed(4));
}

async function main(): Promise<void> {
  const options = await parseArgs(process.argv.slice(2));
  const dataset = loadPreferenceDataset(options.dataset);
  const selected = options.limit === undefined
    ? dataset.examples
    : dataset.examples.slice(0, options.limit);
  const judge = new ProcessPairwiseJudge(options.provider, options.modelId);
  const results: DebiasedJudgeResult[] = [];
  const errors: Array<{ exampleId: string; message: string }> = [];
  const startedAt = Date.now();
  console.log("\n=== Eval V2 Pairwise Judge ===");
  console.log(`Judge: ${judge.id}`);
  console.log(`Examples: ${selected.length} (two judgments per example)\n`);

  for (const example of selected) {
    try {
      const result = await judgeWithPositionDebias(judge, {
        exampleId: example.id,
        userRequest: example.userRequest,
        criteria: example.criteria ?? [],
        candidateA: example.candidateA,
        candidateB: example.candidateB,
      });
      results.push(result);
      console.log(
        `${result.finalWinner === "abstain" ? "⚠️" : "✅"} ${example.id}` +
        ` — ${result.finalWinner} — confidence ${result.confidence}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ exampleId: example.id, message });
      console.log(`❌ ${example.id} — ${message}`);
    }
  }

  const calibration = calibratePreferenceJudge(dataset, results);
  const positionConsistent = results.filter((result) => result.positionConsistent).length;
  const eligibleForCalibration = calibration.reviewedCount >= options.minGold;
  const diagnosticGates = {
    eligibleForCalibration,
    coverage: calibration.coverage >= 0.8,
    exactAgreement: calibration.exactAgreement >= 0.7,
    cohenKappa: calibration.cohenKappa >= 0.6,
    positionConsistency: calibration.positionConsistency >= 0.85,
  };
  const report = {
    schemaVersion: "preference-judge-report-v2",
    generatedAt: new Date().toISOString(),
    dataset: options.dataset,
    judge: { id: judge.id, provider: options.provider, modelId: options.modelId },
    durationMs: Date.now() - startedAt,
    metrics: {
      exampleCount: selected.length,
      completedCount: results.length,
      errorCount: errors.length,
      positionConsistency: Number((positionConsistent / Math.max(1, results.length)).toFixed(4)),
      abstentionRate: Number((
        results.filter((result) => result.finalWinner === "abstain").length /
        Math.max(1, results.length)
      ).toFixed(4)),
      seedReferenceAgreementDiagnostic: seedReferenceAgreement(selected, results),
      calibration,
    },
    diagnosticGates,
    results,
    errors,
  };
  console.log("\n" + JSON.stringify(report.metrics, null, 2));
  if (!eligibleForCalibration) {
    console.log(
      `\nCalibration gates are diagnostic only: reviewed gold ${calibration.reviewedCount}/${options.minGold}.`,
    );
  }
  if (options.output) {
    const output = path.resolve(options.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`Report: ${output}`);
  }
  if (errors.length > 0) process.exitCode = 1;
  if (options.strict && !Object.values(diagnosticGates).every(Boolean)) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 2;
});
