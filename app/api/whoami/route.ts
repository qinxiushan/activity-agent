import { NextResponse } from "next/server";
import { resolveUserContext } from "@/lib/user-context";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const context = await resolveUserContext(req);
  return NextResponse.json({
    userId: context.userId,
    username: context.username,
    authed: context.authed,
    isDev: context.isDev,
    mode: context.mode,
    source: context.source,
  });
}
