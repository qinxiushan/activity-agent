import { NextResponse } from "next/server";
import {
  createAuthSessionToken,
  findUserByUsername,
  verifyPassword,
} from "@/lib/auth-session";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";
import { isDbConfigured } from "@/lib/db";
import { audit } from "@/lib/audit-logger";

export const dynamic = "force-dynamic";

function isJsonRequest(req: Request): boolean {
  const contentType = req.headers.get("content-type") ?? "";
  return contentType.includes("application/json");
}

async function readCredentials(req: Request): Promise<{ username?: string; password?: string } | null> {
  if (isJsonRequest(req)) {
    return (await req.json()) as { username?: string; password?: string };
  }

  const form = await req.formData();
  return {
    username: String(form.get("username") ?? ""),
    password: String(form.get("password") ?? ""),
  };
}

function respondAuthError(
  req: Request,
  error: string,
  status: number,
  username?: string,
): NextResponse {
  if (isJsonRequest(req)) {
    return NextResponse.json({ error }, { status });
  }

  const redirectUrl = new URL("/login", req.url);
  redirectUrl.searchParams.set("error", error);
  if (username) redirectUrl.searchParams.set("username", username);
  return NextResponse.redirect(redirectUrl, { status: 303 });
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!isDbConfigured()) {
    return respondAuthError(req, "auth_unavailable", 503);
  }

  let body: { username?: string; password?: string } | null;
  try {
    body = await readCredentials(req);
  } catch {
    return respondAuthError(req, "invalid_json", 400);
  }

  const username = body?.username?.trim();
  const password = body?.password ?? "";
  if (!username || !password) {
    return respondAuthError(req, "missing_credentials", 400, username);
  }

  const user = await findUserByUsername(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    audit({
      userId: user?.id ?? null,
      sessionId: null,
      eventType: "login_failed",
      detail: { username },
    });
    return respondAuthError(req, "invalid_credentials", 401, username);
  }

  const token = createAuthSessionToken({
    userId: user.id,
    username: user.username,
    iat: Date.now(),
  });

  const res = isJsonRequest(req)
    ? NextResponse.json({
        ok: true,
        user: { id: user.id, username: user.username },
      })
    : NextResponse.redirect(new URL("/", req.url), { status: 303 });
  res.cookies.set(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  audit({
    userId: user.id,
    sessionId: null,
    eventType: "login",
    detail: { username: user.username },
  });
  return res;
}
