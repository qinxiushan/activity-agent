import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Stub: activity-agent doesn't support model testing (pi-web feature).
export async function POST() {
  return NextResponse.json({ ok: false, error: "Model testing is not supported in activity-agent" }, { status: 501 });
}
