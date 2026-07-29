import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple, type TextContent } from "@earendil-works/pi-ai";
import {
  buildJudgePrompt,
  JUDGE_SYSTEM_PROMPT,
  parseJudgeVerdict,
} from "./pairwise-judge";
import type {
  JudgeVerdict,
  PairwiseJudge,
  PairwiseJudgeInput,
} from "./preference-types";

export class PiPairwiseJudge implements PairwiseJudge {
  readonly id: string;
  private readonly registry: ModelRegistry;

  constructor(
    readonly provider: string,
    readonly modelId: string,
    private readonly timeoutMs = 90_000,
  ) {
    this.id = `pi:${provider}/${modelId}`;
    this.registry = ModelRegistry.create(AuthStorage.create());
  }

  async judge(input: PairwiseJudgeInput): Promise<JudgeVerdict> {
    const model = this.registry.find(this.provider, this.modelId);
    if (!model) throw new Error(`Judge model not found: ${this.provider}/${this.modelId}`);
    const auth = await this.registry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    const response = await completeSimple(
      model,
      {
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: buildJudgePrompt(input),
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        temperature: 0,
        maxTokens: 1_600,
        timeoutMs: this.timeoutMs,
        maxRetries: 1,
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? `Judge stopped with ${response.stopReason}`);
    }
    const text = response.content
      .filter((item): item is TextContent => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    return parseJudgeVerdict(text);
  }
}
