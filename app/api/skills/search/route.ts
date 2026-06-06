// Stub: activity-agent doesn't support skills search (pi-web feature).
// Exists so SkillsConfig.tsx can import the SkillSearchResult type without compilation errors.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export interface SkillSearchResult {
  package: string;
  installs: string;
  url: string;
}

// POST /api/skills/search
export async function POST() {
  return NextResponse.json({ results: [] });
}
