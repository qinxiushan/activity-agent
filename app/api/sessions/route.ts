import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { filterSessionsForUser } from "@/lib/session-ownership";
import { resolveUserContext } from "@/lib/user-context";

export async function GET(req: Request) {
  try {
    const context = resolveUserContext(req);
    if (!context.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const sessions = await listAllSessions();
    const visibleSessions = await filterSessionsForUser(sessions, context.userId, context.mode);
    return NextResponse.json({ sessions: visibleSessions });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
