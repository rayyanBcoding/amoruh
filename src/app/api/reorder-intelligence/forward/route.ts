import { NextResponse } from "next/server";
import { getReorderIntelligence } from "@/lib/reorder-db";
import { DEFAULT_WINDOW, WINDOWS, type WindowKey } from "@/lib/reorder-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/reorder-intelligence/forward?window=… — the High Demand / Losing Money (and Buy-Only) rows,
// enriched with the current best ACTIONABLE supplier cost from Pricing / Ordering. Forward-looking guidance
// only: the historical numbers and the Reorder Score in these rows are identical to the main response.
export async function GET(req: Request) {
  try {
    const param = new URL(req.url).searchParams.get("window");
    const window = (WINDOWS.some((w) => w.key === param) ? param : DEFAULT_WINDOW) as WindowKey;
    const result = await getReorderIntelligence(window);
    return NextResponse.json({ window, rows: result.rows.filter((r) => r.forward !== null) });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load supplier guidance: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}
