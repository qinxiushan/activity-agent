/**
 * User Preferences API
 *
 * GET    /api/user-preferences       — get current user's profile
 * PUT    /api/user-preferences       — manually edit defaults (partial)
 * POST   /api/user-preferences       — action=refresh → re-derive from history
 *
 * v2: userId derived from os.userInfo().username; ?userId= or body.userId overrides
 */

import { NextResponse } from "next/server";
import {
  getUserPreferencesStore,
  type UserPreferencesDefaults,
} from "@/lib/user-preferences";
import { getCurrentUserId } from "@/lib/user-context";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId") ?? getCurrentUserId();
  const store = getUserPreferencesStore(userId);
  const prefs = await store.load();
  return NextResponse.json({ preferences: prefs });
}

export async function PUT(req: Request): Promise<NextResponse> {
  let body: { userId?: string; defaults?: Partial<UserPreferencesDefaults> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const userId = body.userId ?? getCurrentUserId();
  if (!body.defaults || typeof body.defaults !== "object") {
    return NextResponse.json({ error: "missing_defaults" }, { status: 400 });
  }
  const store = getUserPreferencesStore(userId);
  const updated = await store.updateDefaults(body.defaults);
  return NextResponse.json({ preferences: updated });
}

export async function POST(req: Request): Promise<NextResponse> {
  let body: { userId?: string; action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const userId = body.userId ?? getCurrentUserId();
  const action = body.action;
  const store = getUserPreferencesStore(userId);

  if (action === "refresh") {
    const updated = await store.refreshFromHistory();
    return NextResponse.json({ preferences: updated, refreshed: true });
  }
  if (action === "reset") {
    await store.reset();
    return NextResponse.json({ preferences: await store.load(), reset: true });
  }
  return NextResponse.json(
    { error: "unknown_action", supported: ["refresh", "reset"] },
    { status: 400 },
  );
}
