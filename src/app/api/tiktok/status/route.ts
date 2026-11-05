import { NextResponse } from "next/server";
import { loadConnection, publicStatus } from "@/lib/tiktok/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tiktok/status — diagnostic: is this environment connected, to which
// shop, and when do the tokens expire. Returns booleans/timestamps/shop identity
// ONLY — never tokens, ciphers, or ciphertext. Behind the site passcode gate.
export async function GET() {
  try {
    return NextResponse.json(publicStatus(await loadConnection()), { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not read TikTok connection status." }, { status: 500 });
  }
}
