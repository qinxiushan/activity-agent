import { NextResponse } from "next/server";
import { buildClearAuthCookie } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", buildClearAuthCookie());
  return res;
}
