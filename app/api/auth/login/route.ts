import { NextResponse } from "next/server";
import {
  buildAuthCookie,
  createAuthSessionToken,
  findUserByUsername,
  verifyPassword,
} from "@/lib/auth-session";
import { isDbConfigured } from "@/lib/db";
import { audit } from "@/lib/audit-logger";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!isDbConfigured()) {
    return NextResponse.json({ error: "auth_unavailable" }, { status: 503 });
  }

  let body: { username?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const username = body.username?.trim();
  const password = body.password ?? "";
  if (!username || !password) {
    return NextResponse.json({ error: "missing_credentials" }, { status: 400 });
  }

  const user = await findUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    audit({
      userId: user?.id ?? null,
      sessionId: null,
      eventType: "login_failed",
      detail: { username },
    });
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const token = createAuthSessionToken({
    userId: user.id,
    username: user.username,
    iat: Date.now(),
  });

  const res = NextResponse.json({
    ok: true,
    user: { id: user.id, username: user.username },
  });
  res.headers.append("Set-Cookie", buildAuthCookie(token));
  audit({
    userId: user.id,
    sessionId: null,
    eventType: "login",
    detail: { username: user.username },
  });
  return res;
}
