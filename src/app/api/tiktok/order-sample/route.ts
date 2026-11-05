import { NextResponse, type NextRequest } from "next/server";
import { TikTokApiError } from "@/lib/tiktok/errors";
import { fetchSanitizedSample } from "@/lib/tiktok/sample";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tiktok/order-sample?count=5
// Milestone 1 inspection route: fetches up to 10 of the most recent orders from
// TikTok (read-only) and returns ONLY a sanitized view — field names, types and
// allow-listed values. Never returns raw order objects, buyer data, tokens or
// the shop cipher. Behind the site passcode gate (src/proxy.ts). To be removed
// once the real response shapes have been reviewed.
const noStore = { "cache-control": "no-store" };

export async function GET(req: NextRequest) {
  try {
    const count = Number(req.nextUrl.searchParams.get("count") ?? 5);
    const sample = await fetchSanitizedSample(count);
    return NextResponse.json(sample, { headers: noStore });
  } catch (err) {
    // Only TikTok's own code / message / request_id — never URLs, tokens or payloads.
    const detail = err instanceof TikTokApiError ? err.describe() : err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: detail }, { status: 502, headers: noStore });
  }
}
