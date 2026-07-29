import { NextResponse } from "next/server";
import { getItineraryService, itineraryFilename } from "@/lib/itinerary-service";
import { resolveUserContext } from "@/lib/user-context";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const context = await resolveUserContext(req);
  if (!context.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const itinerary = await getItineraryService().get(id);
  if (!itinerary) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (itinerary.userId !== context.userId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return new NextResponse(itinerary.ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${itineraryFilename(itinerary)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
