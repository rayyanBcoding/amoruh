import { NextResponse } from "next/server";
import { buildAuthorizeUrl, newOauthState } from "@/lib/tiktok/authorize-url";
import { saveOauthState } from "@/lib/tiktok/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tiktok/auth/start
// Begins seller authorization from inside AMORUH. Sits behind the site passcode
// gate (src/proxy.ts), so only a signed-in AMORUH user can start it. It issues a
// single-use `state` (10-minute TTL, consumed by the callback) and redirects to
// TikTok's authorize page. Nothing secret is placed in the URL.
export async function GET() {
  try {
    const state = newOauthState();
    await saveOauthState(state);
    const res = NextResponse.redirect(buildAuthorizeUrl(state), 302);
    res.headers.set("cache-control", "no-store");
    return res;
  } catch (err) {
    // Message names only a missing setting (never a value).
    const msg = err instanceof Error ? err.message : "Could not start TikTok authorization.";
    return NextResponse.json({ error: msg }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
