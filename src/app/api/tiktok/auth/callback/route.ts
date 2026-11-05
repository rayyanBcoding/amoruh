import { NextResponse, type NextRequest } from "next/server";
import { connectWithAuthCode } from "@/lib/tiktok/auth";
import { callbackRequiresState, TIKTOK_ENV } from "@/lib/tiktok/config";
import { TikTokApiError } from "@/lib/tiktok/errors";
import { consumeOauthState, publicStatus } from "@/lib/tiktok/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tiktok/auth/callback?code=…&state=…
// TikTok redirects the seller here after they approve the app. This route sits
// behind the site passcode gate (src/proxy.ts) like every other route, so the
// browser completing the authorization must be signed in to AMORUH.
//
// The one-time `code` is exchanged server-side immediately; tokens are encrypted
// and stored under this environment's own namespace and are NEVER echoed back.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h1>${title}</h1>${body}</body>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const code = p.get("code");
  const state = p.get("state");
  const error = p.get("error");

  if (error || !code || code === "null") {
    return page("TikTok authorization was not completed", `<p>TikTok returned: <code>${esc(error ?? "no code")}</code>. Nothing was connected.</p>`, 400);
  }

  if (callbackRequiresState()) {
    if (!state || !(await consumeOauthState(state))) {
      return page("TikTok authorization rejected", "<p>Missing or invalid <code>state</code>. Start the authorization again from AMORUH.</p>", 400);
    }
  }

  try {
    const conn = await connectWithAuthCode(code);
    const s = publicStatus(conn);
    const shops = s.connected ? s.shops : [];
    return page(
      "TikTok Shop connected",
      `<p>Environment: <b>${TIKTOK_ENV}</b>. Authorized shops: <b>${shops.length}</b>${shops.map((x) => ` · ${esc(x.name)} (${esc(x.region)})`).join("")}.</p><p>You can close this tab. No tokens are shown or logged.</p>`
    );
  } catch (err) {
    // Only TikTok's code / message / request_id — never URLs, tokens or payloads.
    const detail = err instanceof TikTokApiError ? err.describe() : "Unexpected error while connecting.";
    return page("TikTok connection failed", `<p>${esc(detail)}</p>`, 502);
  }
}
