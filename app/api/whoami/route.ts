import { NextResponse } from "next/server";
import os from "node:os";

export const dynamic = "force-dynamic";

const DEFAULT_USER_ID = "default";

export async function GET(req: Request) {
  const headerUid = req.headers.get("x-user-id");
  if (headerUid) {
    return NextResponse.json({ userId: headerUid, isDev: false });
  }
  const cookieHeader = req.headers.get("cookie") ?? "";
  const m = cookieHeader.match(/(?:^|;\s*)pi_user=([^;]+)/);
  if (m && m[1]) {
    return NextResponse.json({ userId: decodeURIComponent(m[1]), isDev: true });
  }
  return NextResponse.json({
    userId: os.userInfo().username || DEFAULT_USER_ID,
    isDev: false,
  });
}
