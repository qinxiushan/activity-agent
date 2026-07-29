import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai";

async function readStdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return JSON.parse(value);
}

async function main() {
  const provider = process.argv[2];
  const modelId = process.argv[3];
  if (!provider || !modelId) throw new Error("Worker requires provider and modelId");
  const input = await readStdin();
  if (typeof input.systemPrompt !== "string" || typeof input.prompt !== "string") {
    throw new Error("Worker input requires systemPrompt and prompt");
  }
  const registry = ModelRegistry.create(AuthStorage.create());
  const model = registry.find(provider, modelId);
  if (!model) throw new Error(`Judge model not found: ${provider}/${modelId}`);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const response = await completeSimple(
    model,
    {
      systemPrompt: input.systemPrompt,
      messages: [{ role: "user", content: input.prompt, timestamp: Date.now() }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      temperature: 0,
      maxTokens: 1600,
      timeoutMs: 85000,
      maxRetries: 1,
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `Judge stopped with ${response.stopReason}`);
  }
  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  process.stdout.write(JSON.stringify({ ok: true, text }));
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
