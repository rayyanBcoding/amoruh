import { NextResponse } from "next/server";
import { getReceivingEvents } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// GET /api/intake/receiving-events?poId=&productId= — the audit trail
// (§20), newest first. Both filters optional.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const poId = url.searchParams.get("poId") ?? undefined;
  const productId = url.searchParams.get("productId") ?? undefined;

  const events = await getReceivingEvents({ poId, productId });
  return NextResponse.json({ events });
}
