import { NextResponse, type NextRequest } from "next/server";
import { TikTokApiError } from "@/lib/tiktok/errors";
import { importRoom, RoomImportError } from "@/lib/tiktok/import-room";
import { ImportInProgressError } from "@/lib/tiktok/order-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/tiktok/orders/import-room
//   { "roomId": "770…", "dryRun": false, "maxPages": 10, "maxOrdersInspected": 600, "maxRuntimeMs": 40000 }
// Imports ONE complete TikTok LIVE room (bounded; see lib/tiktok/import-room.ts). Read-only
// toward TikTok. If any limit is hit, the room is not found, or ordering is not
// newest-first, it fails clearly and writes NOTHING. dryRun scans and reports without
// writing. No SaleRecord / inventory / profit changes. Behind the passcode gate.
const noStore = { "cache-control": "no-store" };

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => ({}));
    const result = await importRoom(String(b?.roomId ?? ""), {
      dryRun: b?.dryRun === true,
      limits: { maxPages: b?.maxPages, maxOrdersInspected: b?.maxOrdersInspected, maxRuntimeMs: b?.maxRuntimeMs, boundaryConfirm: b?.boundaryConfirm },
    });
    return NextResponse.json(result, { headers: noStore });
  } catch (err) {
    if (err instanceof RoomImportError) return NextResponse.json({ error: err.message, code: err.code, stats: err.stats, imported: false }, { status: err.code === "BAD_ROOM_ID" ? 400 : 422, headers: noStore });
    if (err instanceof ImportInProgressError) return NextResponse.json({ error: err.message }, { status: 409, headers: noStore });
    const detail = err instanceof TikTokApiError ? err.describe() : err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: detail }, { status: 502, headers: noStore });
  }
}
