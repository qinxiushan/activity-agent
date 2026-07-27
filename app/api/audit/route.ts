import { NextResponse } from "next/server";
import { getAuthMode } from "@/lib/auth-mode";
import { listAuditEvents } from "@/lib/audit-logger";
import { resolveUserContext } from "@/lib/user-context";

const DEFAULT_ADMIN_USERS = new Set(["alice"]);

async function canViewAudit(req: Request): Promise<boolean> {
  const context = await resolveUserContext(req);
  if (context.mode !== "required") return true;
  if (!context.authed || !context.username) return false;

  const configured = (process.env.AUDIT_ADMIN_USERS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const admins = configured.length > 0 ? new Set(configured) : DEFAULT_ADMIN_USERS;
  return admins.has(context.username);
}

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  if (getAuthMode() === "required" && !(await canViewAudit(req))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const events = await listAuditEvents({ type, limit });
  return NextResponse.json({
    items: events,
    count: events.length,
  });
}
