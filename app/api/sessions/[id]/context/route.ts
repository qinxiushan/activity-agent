import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { canAccessSession } from "@/lib/session-ownership";
import { resolveUserContext } from "@/lib/user-context";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;

  try {
    const userContext = await resolveUserContext(req);
    if (!userContext.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (!(await canAccessSession(id, userContext.userId, userContext.mode))) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const sm = SessionManager.open(filePath);
    const sessionContext = buildSessionContext(sm.getEntries() as never, leafId);

    return NextResponse.json({ context: sessionContext });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
