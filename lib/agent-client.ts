// Client-side helper for POST /api/agent/[id].

export class AgentApiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;

  constructor(message: string, options: { status: number; code?: string; retryAfterMs?: number }) {
    super(message);
    this.name = "AgentApiError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function extractApiError(
  status: number,
  body: { error?: string; message?: string; retryAfterMs?: number },
): AgentApiError {
  return new AgentApiError(
    body.message ?? body.error ?? `HTTP ${status}`,
    {
      status,
      code: body.error,
      retryAfterMs: body.retryAfterMs,
    },
  );
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    message?: string;
    retryAfterMs?: number;
  };
  if (!res.ok || body.error) {
    throw extractApiError(res.status, body);
  }
  return body.data as T;
}
