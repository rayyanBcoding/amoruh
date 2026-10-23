import { NextResponse } from "next/server";
import { getReorderIntelligence } from "@/lib/reorder-db";
import { DEFAULT_WINDOW, WINDOWS, type WindowKey } from "@/lib/reorder-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/reorder-intelligence?window=last5|last3|last10|7d|30d|all
// Product performance + Reorder Score for the selected period, derived live
// from the existing LIVE SaleRecords (read-only; nothing is stored or changed).
// Historical only — the forward-looking supplier guidance for losing-money
// products loads separately (…/forward) so the table paints fast.
export async function GET(req: Request) {
  try {
    const param = new URL(req.url).searchParams.get("window");
    const window = (WINDOWS.some((w) => w.key === param) ? param : DEFAULT_WINDOW) as WindowKey;
    return NextResponse.json(await getReorderIntelligence(window, null));
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load Reorder Intelligence: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
