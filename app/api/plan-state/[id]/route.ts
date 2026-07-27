import { NextResponse } from "next/server";
import { getPlanStateRepo } from "@/lib/storage";
import { canAccessOwner } from "@/lib/session-ownership";
import { resolveUserContext } from "@/lib/user-context";
import { hashOf } from "@/lib/plan-reducer";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  try {
    const context = await resolveUserContext(req);
    if (!context.userId) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const state = await getPlanStateRepo().load(id);
    if (!state) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (!canAccessOwner(state.userId, context.userId, context.mode)) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.json({ ...state, planHash: hashOf(state.plan) });
  } catch (e) {
    return NextResponse.json(
      { error: "read_failed", message: (e as Error).message },
      { status: 500 },
    );
  }
}
