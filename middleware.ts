import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { getAuthMode } from "@/lib/auth-mode";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/health",
  "/api/health/ready",
  "/api/metrics",
  "/_next",
  "/favicon.ico",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export default async function middleware(req: NextRequest) {
  const mode = getAuthMode();
  if (mode !== "required") return NextResponse.next();

  const { pathname } = req.nextUrl;
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
  });
  const hasSession = Boolean(token?.sub);

  if (pathname === "/login" && hasSession) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (hasSession) {
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
