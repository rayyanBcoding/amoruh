import { NextResponse, type NextRequest } from "next/server";
import { TikTokApiError } from "@/lib/tiktok/errors";
import { importRecentOrders } from "@/lib/tiktok/import-recent";
import { ImportInProgressError } from "@/lib/tiktok/order-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/tiktok/orders/import  { "window": 100 }
// MANUAL, one-shot import of the most recent orders (max 100) into the TikTok record
// store (amoruh:tiktok:{env}:* only). Read-only toward TikTok. It creates no SaleRecord,
// changes no inventory / profit / catalog data and is NOT a backfill (hard cap: one
// window). Safe to repeat: identical data causes no writes. Behind the passcode gate.
const noStore = { "cache-control": "no-store" };

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const summary = await importRecentOrders(Number(body?.window ?? 100));
    return NextResponse.json(summary, { headers: noStore });
  } catch (err) {
    if (err instanceof ImportInProgressError) return NextResponse.json({ error: err.message }, { status: 409, headers: noStore });
    const detail = err instanceof TikTokApiError ? err.describe() : err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: detail }, { status: 502, headers: noStore });
  }
}
