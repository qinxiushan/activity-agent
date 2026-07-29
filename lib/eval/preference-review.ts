import { createHash, randomUUID } from "node:crypto";
import type {
  PreferenceDataset,
  PreferenceLabel,
  PreferenceReviewBundle,
  PreferenceReviewManifest,
  PreferenceReviewPacket,
} from "./preference-types";

function shouldSwap(packetId: string, exampleId: string): boolean {
  const digest = createHash("sha256").update(`${packetId}:${exampleId}`).digest();
  return (digest[0] & 1) === 1;
}

export function createPreferenceReviewBundle(
  dataset: PreferenceDataset,
  options: { packetId?: string; rubricVersion?: string } = {},
): PreferenceReviewBundle {
  const packetId = options.packetId ?? `review-${randomUUID()}`;
  const rubricVersion = options.rubricVersion ?? "activity-preference-v2";
  const records: PreferenceReviewManifest["records"] = [];
  const items: PreferenceReviewPacket["items"] = dataset.examples.map((example) => {
    const swap = shouldSwap(packetId, example.id);
    const leftSource = swap ? "b" : "a";
    const rightSource = swap ? "a" : "b";
    const left = structuredClone(swap ? example.candidateB : example.candidateA);
    const right = structuredClone(swap ? example.candidateA : example.candidateB);
    left.id = "candidate-left";
    right.id = "candidate-right";
    records.push({
      exampleId: example.id,
      blindedLeftId: left.id,
      blindedRightId: right.id,
      leftCandidateSource: leftSource,
      rightCandidateSource: rightSource,
    });
    return {
      exampleId: example.id,
      userRequest: example.userRequest,
      criteria: example.criteria ?? [],
      left,
      right,
    };
  });
  return {
    packet: {
      schemaVersion: "preference-review-v2",
      packetId,
      rubricVersion,
      createdAt: new Date().toISOString(),
      items,
    },
    manifest: {
      schemaVersion: "preference-review-manifest-v2",
      packetId,
      records,
    },
  };
}

function mapReviewLabel(
  label: "left" | "right" | "tie",
  leftSource: "a" | "b",
): PreferenceLabel {
  if (label === "tie") return "tie";
  if (label === "left") return leftSource;
  return leftSource === "a" ? "b" : "a";
}

export function applyPreferenceReview(
  dataset: PreferenceDataset,
  packet: PreferenceReviewPacket,
  manifest: PreferenceReviewManifest,
  annotatorId: string,
): PreferenceDataset {
  if (!annotatorId.trim()) throw new Error("annotatorId is required");
  if (packet.packetId !== manifest.packetId) throw new Error("Packet and manifest ids differ");
  const itemById = new Map(packet.items.map((item) => [item.exampleId, item]));
  const recordById = new Map(manifest.records.map((record) => [record.exampleId, record]));
  const completed = packet.items.filter((item) => item.label !== undefined);
  if (completed.length !== packet.items.length) {
    throw new Error(`Review packet is incomplete: ${completed.length}/${packet.items.length}`);
  }
  return {
    ...dataset,
    examples: dataset.examples.map((example) => {
      const item = itemById.get(example.id);
      const record = recordById.get(example.id);
      if (!item || !record || !item.label) {
        throw new Error(`Missing review mapping for ${example.id}`);
      }
      if (
        item.confidence !== undefined &&
        (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)
      ) {
        throw new Error(`Invalid confidence for ${example.id}`);
      }
      return {
        ...example,
        annotation: {
          status: "reviewed" as const,
          label: mapReviewLabel(item.label, record.leftCandidateSource),
          rubricVersion: packet.rubricVersion,
          confidence: item.confidence,
          annotatorIds: [annotatorId],
          rationale: item.rationale,
        },
      };
    }),
  };
}
