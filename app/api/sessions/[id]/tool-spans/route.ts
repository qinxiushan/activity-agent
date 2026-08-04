import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { canAccessSession } from "@/lib/session-ownership";
import { resolveUserContext } from "@/lib/user-context";
import { listToolExecutionSpans } from "@/lib/tool-telemetry";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const userContext = await resolveUserContext(req);
    if (!userContext.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!(await resolveSessionPath(id))) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (!(await canAccessSession(id, userContext.userId, userContext.mode))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const url = new URL(req.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? 2_000);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 2_000;
    const spans = await listToolExecutionSpans({ sessionId: id, limit });
    return NextResponse.json({ sessionId: id, spans });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
