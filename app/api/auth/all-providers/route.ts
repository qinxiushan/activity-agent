export const dynamic = "force-dynamic";

// Stub: activity-agent doesn't support provider listing (pi-web feature).
export async function GET() {
  return Response.json({ providers: [] });
}
