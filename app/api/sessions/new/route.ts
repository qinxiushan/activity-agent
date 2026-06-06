// This route is no longer used — new sessions are created fully client-side via /api/agent/new.
// Kept as a no-op for reference (matching pi-web).
export async function POST() {
  return new Response("Not used", { status: 410 });
}
