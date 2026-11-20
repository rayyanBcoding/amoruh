import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "@/lib/auth";
import { getProducts } from "@/lib/db";
import { getAllReceivingEvents } from "@/lib/intake-db";
import type { ReceivingEvent } from "@/lib/intake-types";
import { getLiveNotesView } from "@/lib/live-notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "private, no-store", "vary": "Cookie" };

// Temporary internal export. The site passcode proxy also protects this route.
// Explicit projection only: never spread Product or export free-form internal notes.
export async function GET(req: NextRequest) {
  if (!(await verifyAuthToken(req.cookies.get(AUTH_COOKIE_NAME)?.value))) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401, headers });
  }
  try {
    const [catalog, receipts] = await Promise.all([getProducts(), getAllReceivingEvents()]);
    const latest = new Map<string, ReceivingEvent>();
    for (const event of receipts) {
      // A zero-quantity/not-received event is not a receipt of stock.
      if (!event.productId || !(event.actualQty > 0) || !Number.isFinite(Date.parse(event.timestamp))) continue;
      const previous = latest.get(event.productId);
      if (!previous || Date.parse(event.timestamp) > Date.parse(previous.timestamp)) latest.set(event.productId, event);
    }
    const products = catalog
      .filter((p) => Number.isFinite(p.inventory) && p.inventory > 0)
      .map((p) => {
        const notes = getLiveNotesView(p);
        const receipt = latest.get(p.id);
        // retailReference is not defined in the current Product model. Report
        // presence defensively, but never invent verification semantics.
        const reference = (p as unknown as Record<string, unknown>).retailReference;
        return {
          productId: p.id,
          brand: p.brand,
          productName: p.name,
          concentration: p.concentration,
          size: p.size,
          condition: p.condition,
          stockQuantity: p.inventory,
          barcode: p.barcode || null,
          sku: p.sku || null,
          // There is no structured gift-set contents field in the current model.
          // Product names may contain contents; do not infer them from internal notes.
          giftSetContents: null,
          hasLiveNotes: notes !== null,
          hasKeyScentNotes: !!notes?.keyNotes.some((n) => n.trim()),
          hasVibe: !!notes?.vibe.trim(),
          hasBestSeasonOccasion: !!notes?.bestFor.trim(),
          liveNotesSource: notes?.source ?? null,
          liveNotesNeedsReview: notes?.check ?? false,
          hasQuickSellingLine: !!p.sellingQuickLine?.trim(),
          hasRetailReference: reference !== undefined && reference !== null,
          retailReferenceVerified: reference == null ? false : null,
          latestReceipt: receipt ? {
            receiptId: receipt.id,
            intakeId: receipt.poId,
            intakeNumber: receipt.poNumber,
            batchReference: receipt.batchId ?? null,
            receivedAt: receipt.timestamp,
          } : null,
        };
      });
    return NextResponse.json({
      exportedAt: new Date().toISOString(),
      count: products.length,
      retailReferenceNote: "Retail Reference has no implemented verification model yet; verified is false when absent, null (unknown) if an unrecognized reference exists. Existing retailPrice is not a verified reference.",
      giftSetContentsNote: "No structured set contents are stored; check productName or verify manually.",
      products,
    }, { headers: { ...headers, "content-disposition": 'attachment; filename="amoruh-in-stock-catalog.json"' } });
  } catch {
    // Do not expose Redis configuration or internal error details in the download.
    return NextResponse.json({ error: "Could not export inventory." }, { status: 500, headers });
  }
}
