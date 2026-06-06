export const dynamic = "force-dynamic";

// Stub: activity-agent doesn't support OAuth login (pi-web feature).
// GET returns a minimal SSE stream that immediately errors.

type Params = { params: Promise<{ provider: string }> };

export async function GET(_req: Request, { params }: Params) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ type: "error", message: "OAuth login is not supported in activity-agent" })}\n\n`
      ));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function POST() {
  return Response.json({ error: "OAuth login is not supported in activity-agent" }, { status: 501 });
}
