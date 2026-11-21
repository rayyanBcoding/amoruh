import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { getProducts } from "@/lib/db";
import { planIntakeEnrichment } from "@/lib/intake-live-enrichment";
import { updateCatalogMetadata } from "@/lib/product-metadata-db";
import { broadcastStateChanged } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store", vary: "Cookie" };
async function authorized(req: NextRequest) { return verifyAuthToken(req.cookies.get(AUTH_COOKIE_NAME)?.value); }
export async function GET(req: NextRequest) {
  if (!await authorized(req)) return NextResponse.json({ error: "Not authorized." }, { status: 401, headers });
  try { return NextResponse.json({ mode: "preview", ...planIntakeEnrichment(await getProducts()).result }, { headers }); }
  catch { return NextResponse.json({ error: "Could not preview enrichment." }, { status: 500, headers }); }
}
export async function POST(req: NextRequest) {
  if (!await authorized(req)) return NextResponse.json({ error: "Not authorized." }, { status: 401, headers });
  if (req.headers.get("origin") !== req.nextUrl.origin) return NextResponse.json({ error: "Same-origin request required." }, { status: 403, headers });
  try {
    if ((await req.json()).apply !== true) return NextResponse.json({ error: "apply: true is required." }, { status: 400, headers });
    const result = await updateCatalogMetadata(planIntakeEnrichment);
    broadcastStateChanged("intake-live-enrichment");
    return NextResponse.json({ mode: "applied", ...result }, { headers });
  } catch { return NextResponse.json({ error: "Could not apply enrichment. Retry safely; existing notes and references are preserved." }, { status: 409, headers }); }
}
