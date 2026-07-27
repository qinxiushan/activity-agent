import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { startRpcSession } from "@/lib/rpc-manager";
import { resolveUserContext } from "@/lib/user-context";
import {
  buildRateLimitHeaders,
  checkMessageRateLimit,
  formatRateLimitError,
  isMessageRateLimitedCommand,
} from "@/lib/rate-limiter";
import { guardPromptCommand } from "@/lib/input-guard-route";
import { audit } from "@/lib/audit-logger";

// POST /api/agent/new  body: { cwd: string; type: string; message: string; ... }
// Spawns a brand-new pi session and immediately sends the first command.
// Returns { sessionId, data } where sessionId is pi's real session id.
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; [key: string]: unknown };
    const { cwd, ...command } = body;
    const context = await resolveUserContext(req);
    if (!context.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const userId = context.userId;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }
    const guarded = guardPromptCommand(command, { userId, sessionId: null });
    if (!guarded.ok) {
      return NextResponse.json(guarded.body, { status: guarded.status });
    }
    const safeCommand = guarded.command;

    if (isMessageRateLimitedCommand(safeCommand)) {
      const verdict = await checkMessageRateLimit(userId);
      if (!verdict.allowed) {
        audit({
          userId,
          sessionId: null,
          eventType: "rate_limited",
          detail: {
            action: "message",
            retryAfterMs: verdict.retryAfterMs,
            limit: verdict.limit,
          },
        });
        return NextResponse.json(formatRateLimitError(verdict.retryAfterMs), {
          status: 429,
          headers: buildRateLimitHeaders(verdict.retryAfterMs),
        });
      }
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, thinkingLevel, ...promptCommand } = safeCommand as { provider?: string; modelId?: string; thinkingLevel?: string; [key: string]: unknown };

    const tempKey = `__new__${Date.now()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, userId);

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    globalThis.__piAllowedRootsCache?.roots.add(cwd);

    // Apply pre-selected model before sending the prompt
    if (provider && modelId) {
      await session.send({ type: "set_model", provider, modelId });
    }

    // Apply pre-selected thinking level before sending the prompt
    if (thinkingLevel) {
      await session.send({ type: "set_thinking_level", level: thinkingLevel });
    }

    const result = await session.send(promptCommand);

    return NextResponse.json({ success: true, sessionId: realSessionId, data: result });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
