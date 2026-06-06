import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PLAN_STATES_DIR = path.join(os.homedir(), ".pi", "agent", "plan-states");

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const file = path.join(PLAN_STATES_DIR, `${id}.json`);
  if (!existsSync(file)) {
    return NextResponse.json({ error: "not_found", path: file }, { status: 404 });
  }
  try {
    const content = await readFile(file, "utf-8");
    return NextResponse.json(JSON.parse(content));
  } catch (e) {
    return NextResponse.json(
      { error: "read_failed", message: (e as Error).message },
      { status: 500 },
    );
  }
}
