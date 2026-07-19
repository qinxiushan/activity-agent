import { audit } from "./audit-logger";
import { validateUserInput } from "./input-guard";

export function guardPromptCommand<T extends { type?: unknown; message?: unknown }>(
  command: T,
  context: { userId: string | null; sessionId?: string | null },
): { ok: true; command: T } | { ok: false; status: 400; body: { error: string; message: string; maxChars?: number } } {
  const type = typeof command.type === "string" ? command.type : "";
  if (type !== "prompt" && type !== "steer" && type !== "follow_up") {
    return { ok: true, command };
  }
  const message = typeof command.message === "string" ? command.message : "";
  const verdict = validateUserInput(message);

  if (verdict.keyword) {
    audit({
      userId: context.userId,
      sessionId: context.sessionId ?? null,
      eventType: "injection_detected",
      detail: {
        source: "user_input",
        keyword: verdict.keyword,
      },
    });
  }

  if (!verdict.ok) {
    audit({
      userId: context.userId,
      sessionId: context.sessionId ?? null,
      eventType: "input_rejected",
      detail: {
        length: verdict.sanitizedLength,
        maxChars: 10_000,
      },
    });
    return {
      ok: false,
      status: 400,
      body: {
        error: "input_too_long",
        message: "消息过长（上限 10000 字符）",
        maxChars: 10_000,
      },
    };
  }

  if (verdict.sanitized !== message) {
    return {
      ok: true,
      command: {
        ...command,
        message: verdict.sanitized,
      },
    };
  }

  return { ok: true, command };
}

