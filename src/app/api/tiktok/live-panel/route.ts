import { NextResponse, type NextRequest } from "next/server";
import { getPanel } from "@/lib/tiktok/live-panel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tiktok/live-panel?roomId=latest|<room_id>
// Go Live TikTok panel data: stored rooms + the selected room's auction rows and saved
// matches. Reads only our own stored TikTok records (does NOT call TikTok). Behind the passcode gate.
export async function GET(req: NextRequest) {
  try {
    const roomId = req.nextUrl.searchParams.get("roomId");
    return NextResponse.json(await getPanel(roomId), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not load the TikTok panel." }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
