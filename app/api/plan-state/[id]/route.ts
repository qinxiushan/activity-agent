import { NextResponse } from "next/server";
import { getPlanStateRepo } from "@/lib/storage";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    const state = await getPlanStateRepo().load(id);
    if (!state) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(state);
  } catch (e) {
    return NextResponse.json(
      { error: "read_failed", message: (e as Error).message },
      { status: 500 },
    );
  }
}
