import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { getProducts } from "@/lib/db";
import { planIntakeEnrichment } from "@/lib/intake-live-enrichment";
import { updateCatalogMetadata } from "@/lib/product-metadata-db";
import { broadcastStateChanged } from "@/lib/events";
import catalogBatch from "@/lib/data/catalog-live-enrichment.json";
import { getLiveNotesView } from "@/lib/live-notes";
import { isVerifiedRetail } from "@/lib/retail-reference";
import type { Product } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "private, no-store", vary: "Cookie" };
async function authorized(req: NextRequest) { return verifyAuthToken(req.cookies.get(AUTH_COOKIE_NAME)?.value); }
function totals(products: Product[]) {
  const stock = products.filter((p) => p.inventory > 0);
  const completeLiveNotes = stock.filter((p) => {
    const n = getLiveNotesView(p);
    return n?.keyNotes.some((v) => v.trim()) && n.vibe.trim() && n.bestFor.trim();
  }).length;
  const verifiedRetailReferences = stock.filter((p) => isVerifiedRetail(p)).length;
  return {
    totalInStock: stock.length, completeLiveNotes,
    unresolvedLiveNotes: stock.length - completeLiveNotes,
    verifiedRetailReferences, notVerifiedRetailReferences: stock.length - verifiedRetailReferences,
    missingRetailRecords: stock.filter((p) => !p.retailReference).length,
    notesFlaggedForReview: stock.filter((p) => getLiveNotesView(p)?.check || p.liveNotes?.check).length,
    outsideReviewedCatalog: stock.filter((p) => !catalogBatch.some((r) => r.productId === p.id)).length,
  };
}
function plan(req: NextRequest, current: Product[]) {
  const result = req.nextUrl.searchParams.get("scope") === "catalog"
    ? planIntakeEnrichment(current, catalogBatch)
    : planIntakeEnrichment(current);
  return { ...result, result: { ...result.result, totals: totals(result.products) } };
}
export async function GET(req: NextRequest) {
  if (!await authorized(req)) return NextResponse.json({ error: "Not authorized." }, { status: 401, headers });
  try {
    const current = await getProducts();
    return NextResponse.json({ mode: "preview", currentTotals: totals(current), ...plan(req, current).result }, { headers });
  }
  catch { return NextResponse.json({ error: "Could not preview enrichment." }, { status: 500, headers }); }
}
export async function POST(req: NextRequest) {
  if (!await authorized(req)) return NextResponse.json({ error: "Not authorized." }, { status: 401, headers });
  if (req.headers.get("origin") !== req.nextUrl.origin) return NextResponse.json({ error: "Same-origin request required." }, { status: 403, headers });
  try {
    if ((await req.json()).apply !== true) return NextResponse.json({ error: "apply: true is required." }, { status: 400, headers });
    const result = await updateCatalogMetadata((current) => plan(req, current));
    broadcastStateChanged("intake-live-enrichment");
    return NextResponse.json({ mode: "applied", ...result }, { headers });
  } catch { return NextResponse.json({ error: "Could not apply enrichment. Retry safely; existing notes and references are preserved." }, { status: 409, headers }); }
}
