import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveUserContext } from "@/lib/user-context";
import {
  buildRateLimitHeaders,
  checkMessageRateLimit,
  formatRateLimitError,
  isMessageRateLimitedCommand,
} from "@/lib/rate-limiter";
import { canAccessSession } from "@/lib/session-ownership";
import { guardPromptCommand } from "@/lib/input-guard-route";
import { audit } from "@/lib/audit-logger";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    const context = await resolveUserContext(req);
    if (!context.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const userId = context.userId;

    const guarded = guardPromptCommand(body, { userId, sessionId: id });
    if (!guarded.ok) {
      return NextResponse.json(guarded.body, { status: guarded.status });
    }
    const safeBody = guarded.command;

    if (isMessageRateLimitedCommand(safeBody)) {
      const verdict = await checkMessageRateLimit(userId);
      if (!verdict.allowed) {
        audit({
          userId,
          sessionId: id,
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

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(safeBody);
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (!(await canAccessSession(id, userId, context.mode))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const cwd = SessionManager.open(filePath).getHeader()?.cwd ?? process.cwd();

    const { session } = await startRpcSession(id, filePath, cwd, userId);
    const result = await session.send(safeBody);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const context = await resolveUserContext(req);
    if (!context.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!(await canAccessSession(id, context.userId, context.mode))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
