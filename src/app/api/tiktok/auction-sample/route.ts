import { NextResponse, type NextRequest } from "next/server";
import { fetchAuctionSample } from "@/lib/tiktok/auction-sample";
import { TikTokApiError } from "@/lib/tiktok/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tiktok/auction-sample?rows=25&window=100
// Milestone 1 validation route: reads the most recent orders (read-only), projects
// each line item onto a fixed non-personal field list, and reports per-LIVE-room
// auction-number analysis. Returns NO buyer / recipient data, tokens or ciphers.
// Behind the site passcode gate (src/proxy.ts). Temporary — removed once the
// matching key has been reviewed.
const noStore = { "cache-control": "no-store" };

export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams;
    const sample = await fetchAuctionSample({ rows: Number(p.get("rows") ?? 25), window: Number(p.get("window") ?? 100) });
    return NextResponse.json(sample, { headers: noStore });
  } catch (err) {
    const detail = err instanceof TikTokApiError ? err.describe() : err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: detail }, { status: 502, headers: noStore });
  }
}
