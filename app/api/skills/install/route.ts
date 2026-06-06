import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Stub: activity-agent doesn't support skills installation (pi-web feature).
export async function POST() {
  return NextResponse.json(
    { error: "Skills installation is not supported in activity-agent" },
    { status: 501 }
  );
}
