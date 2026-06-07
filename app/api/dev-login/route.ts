/**
 * Dev Login — set/clear the pi_user cookie for browser-based testing.
 *
 * NOT real auth. No password, no token validation. The userId is accepted as-is.
 * For production, replace with proper auth (OAuth, signed session, etc.).
 *
 * POST   /api/dev-login  { userId: "alice" }   → sets pi_user=alice cookie
 * DELETE /api/dev-login                         → clears pi_user cookie
 * GET    /api/dev-login                         → reports current pi_user cookie
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const COOKIE_NAME = "pi_user";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function readCookie(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const m = cookieHeader.match(/(?:^|;\s*)pi_user=([^;]+)/);
  if (m && m[1]) return decodeURIComponent(m[1]);
  return null;
}

function buildSetCookie(value: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

function buildClearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
}

export async function GET(req: Request): Promise<NextResponse> {
  return NextResponse.json({ userId: readCookie(req) });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { userId?: string };
  try {
    body = (await req.json()) as { userId?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.userId || typeof body.userId !== "string" || !body.userId.trim()) {
    return NextResponse.json({ error: "missing_userId" }, { status: 400 });
  }
  const res = NextResponse.json({ userId: body.userId, ok: true });
  res.headers.append("Set-Cookie", buildSetCookie(body.userId));
  return res;
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const previous = readCookie(req);
  const res = NextResponse.json({ userId: null, ok: true, previous });
  res.headers.append("Set-Cookie", buildClearCookie());
  return res;
}
