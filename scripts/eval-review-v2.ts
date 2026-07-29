import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPreferenceDataset, parsePreferenceDataset } from "../lib/eval/preference-dataset";
import {
  applyPreferenceReview,
  createPreferenceReviewBundle,
} from "../lib/eval/preference-review";
import type {
  PreferenceReviewManifest,
  PreferenceReviewPacket,
} from "../lib/eval/preference-types";

function value(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function writeJson(filePath: string, valueToWrite: unknown): Promise<void> {
  const resolved = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, JSON.stringify(valueToWrite, null, 2) + "\n", "utf8");
}

async function createMode(argv: string[]): Promise<void> {
  const datasetPath = path.resolve(
    value(argv, "--dataset") ?? "evals/datasets/preference-seed-v2.json",
  );
  const outputDir = path.resolve(value(argv, "--output-dir") ?? "evals/reviews");
  const dataset = loadPreferenceDataset(datasetPath);
  const bundle = createPreferenceReviewBundle(dataset, {
    packetId: value(argv, "--packet-id"),
  });
  const packetPath = path.join(outputDir, `${bundle.packet.packetId}.packet.json`);
  const manifestPath = path.join(outputDir, `${bundle.packet.packetId}.manifest.json`);
  await writeJson(packetPath, bundle.packet);
  await writeJson(manifestPath, bundle.manifest);
  console.log(`Review packet: ${packetPath}`);
  console.log(`Private manifest: ${manifestPath}`);
  console.log("只把 packet 交给评审者；manifest 包含换位映射，必须与评审者隔离。");
}

async function applyMode(argv: string[]): Promise<void> {
  const required = (name: string) => {
    const result = value(argv, name);
    if (!result) throw new Error(`${name} is required in apply mode`);
    return result;
  };
  const datasetPath = path.resolve(
    value(argv, "--dataset") ?? "evals/datasets/preference-seed-v2.json",
  );
  const packetPath = path.resolve(required("--packet"));
  const manifestPath = path.resolve(required("--manifest"));
  const outputPath = path.resolve(required("--output"));
  const annotatorId = required("--annotator");
  const dataset = loadPreferenceDataset(datasetPath);
  const packet = JSON.parse(await fs.readFile(packetPath, "utf8")) as PreferenceReviewPacket;
  const manifest = JSON.parse(
    await fs.readFile(manifestPath, "utf8"),
  ) as PreferenceReviewManifest;
  const reviewed = applyPreferenceReview(dataset, packet, manifest, annotatorId);
  parsePreferenceDataset(reviewed);
  await writeJson(outputPath, reviewed);
  console.log(`Reviewed dataset: ${outputPath}`);
  console.log(`Reviewed examples: ${reviewed.examples.length}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const mode = value(argv, "--mode") ?? "create";
  if (mode === "create") return createMode(argv);
  if (mode === "apply") return applyMode(argv);
  throw new Error("--mode must be create or apply");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  console.error(`Host: ${os.hostname()}`);
  process.exitCode = 2;
});
