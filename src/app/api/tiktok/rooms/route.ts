import { NextResponse, type NextRequest } from "next/server";
import { getRoom, getRoomsIndex, getRoomView } from "@/lib/tiktok/order-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tiktok/rooms               → stored TikTok rooms, newest first
// GET /api/tiktok/rooms?roomId=…      → one room's auction slots (joined view, no personal data)
// Reads only our own stored TikTok records — it does not call TikTok. Behind the passcode gate.
const noStore = { "cache-control": "no-store" };

export async function GET(req: NextRequest) {
  try {
    const roomId = req.nextUrl.searchParams.get("roomId");
    if (!roomId) {
      const index = await getRoomsIndex();
      const rooms = await Promise.all((index?.rooms ?? []).map(async (x) => getRoom(x.roomId)));
      return NextResponse.json({ rooms: rooms.filter(Boolean).map((r) => ({ ...r!, slots: undefined })) }, { headers: noStore });
    }
    const view = await getRoomView(roomId);
    if (!view) return NextResponse.json({ error: "Unknown room." }, { status: 404, headers: noStore });
    return NextResponse.json(view, { headers: noStore });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500, headers: noStore });
  }
}
