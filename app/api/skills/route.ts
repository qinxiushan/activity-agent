import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Stub: activity-agent doesn't support skills management (pi-web feature).
export async function GET() {
  return NextResponse.json({ skills: [], diagnostics: [] });
}
