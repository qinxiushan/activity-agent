export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

// Stub: activity-agent doesn't support OAuth login, so logout is a no-op.
export async function POST(_req: Request, { params }: Params) {
  const { provider } = await params;
  return Response.json({ ok: true, provider });
}
