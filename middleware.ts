import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/auth-constants";
import { getAuthMode } from "@/lib/auth-mode";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/health",
  "/api/health/ready",
  "/api/metrics",
  "/_next",
  "/favicon.ico",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function middleware(req: NextRequest) {
  const mode = getAuthMode();
  if (mode !== "required") return NextResponse.next();

  const { pathname } = req.nextUrl;
  const hasAuthCookie = Boolean(req.cookies.get(AUTH_COOKIE_NAME)?.value);

  if (pathname === "/login" && hasAuthCookie) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (hasAuthCookie) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: ["/((?!.*\\..*).*)", "/api/:path*"],
};
