import { NextResponse } from "next/server";
import { TikTokApiError } from "@/lib/tiktok/errors";
import { importRoom, RoomImportError } from "@/lib/tiktok/import-room";
import { ImportInProgressError } from "@/lib/tiktok/order-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/tiktok/live-panel/refresh { roomId?: "latest" | "<room_id>" }
// Manual "Refresh TikTok Orders": safely imports/updates ONE room (bounded, idempotent,
// read-only toward TikTok). "latest" = the room of the newest order (the LIVE in progress).
// No SaleRecords, no inventory/profit changes, no cron/webhooks. A failure leaves stored
// data untouched, and the manual Go Live flow keeps working regardless.
const noStore = { "cache-control": "no-store" };

export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({}));
    const roomId = typeof b?.roomId === "string" && b.roomId ? b.roomId : "latest";
    const r = await importRoom(roomId);
    return NextResponse.json(
      {
        ok: true,
        roomId: r.roomId,
        orders: r.scanned.orders,
        auctionNoMax: r.scanned.auctionNoMax,
        paid: r.scanned.paid,
        unpaidCancelled: r.scanned.unpaidCancelled,
        created: r.import?.created ?? 0,
        updated: r.import?.updated ?? 0,
        unchanged: r.import?.unchanged ?? 0,
        statusChanges: r.import?.statusChanges ?? 0,
        elapsedMs: r.scan.elapsedMs,
      },
      { headers: noStore }
    );
  } catch (err) {
    if (err instanceof ImportInProgressError) return NextResponse.json({ ok: false, error: "A refresh is already running — wait a few seconds and try again." }, { status: 409, headers: noStore });
    if (err instanceof RoomImportError) return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: 422, headers: noStore });
    const detail = err instanceof TikTokApiError ? err.describe() : err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ ok: false, error: `TikTok did not respond: ${detail}` }, { status: 502, headers: noStore });
  }
}
