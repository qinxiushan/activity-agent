import { NextResponse } from "next/server";

const AUTH_COOKIE_NAMES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "authjs.csrf-token",
  "__Host-authjs.csrf-token",
  "authjs.callback-url",
  "__Secure-authjs.callback-url",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

function redirectToLogin(req: Request): NextResponse {
  const response = NextResponse.redirect(new URL("/login", req.url), { status: 303 });
  for (const name of AUTH_COOKIE_NAMES) {
    response.cookies.set(name, "", {
      path: "/",
      maxAge: 0,
      httpOnly: name.includes("session-token"),
      sameSite: "lax",
    });
  }
  return response;
}

export function POST(req: Request): NextResponse {
  return redirectToLogin(req);
}

export function GET(req: Request): NextResponse {
  return redirectToLogin(req);
}
