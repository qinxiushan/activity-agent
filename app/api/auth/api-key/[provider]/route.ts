import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { provider } = await params;
  return NextResponse.json({ provider, configured: false, source: null, models: 0 });
}

export async function POST() {
  return NextResponse.json({ error: "API key management is not supported in activity-agent" }, { status: 501 });
}

export async function DELETE() {
  return NextResponse.json({ error: "API key management is not supported in activity-agent" }, { status: 501 });
}
