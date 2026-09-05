import { NextResponse } from "next/server";
import { getProducts } from "@/lib/db";
import { getPO, getPOLines } from "@/lib/intake-db";
import { matchLineItem } from "@/lib/intake-matching";
import { createAndLinkProductForLine, type CreateAndLinkResult } from "@/lib/intake-product-linking";

export const dynamic = "force-dynamic";

// POST /api/intake/pos/[id]/bulk-create-products
//
// "Create N New Products" for a PO that's already saved — runs
// createAndLinkProductForLine() for every currently-eligible unmatched
// line (matchType "unmatched", not currently linked to a real product),
// continuing past individual failures so one bad line doesn't block the
// rest. Retry-safe: calling it again only ever touches lines still
// eligible at that moment, so an already-linked line from a prior
// attempt is simply skipped, never re-created.
//
// Safety check before creating anything: re-run the fuzzy matcher
// against today's catalog (not just the exact-match revalidation inside
// createAndLinkProductForLine). A line that was genuinely unmatched when
// the PO was first reviewed might have a decent candidate now — bulk
// create must not paper over that with a duplicate; it's reported as
// "needs_review" instead, same as the individual "Possible Match" flow.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const po = await getPO(id);
  if (!po) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
  if (po.status === "closed") return NextResponse.json({ error: "This PO is closed." }, { status: 400 });

  const [lines, products] = await Promise.all([getPOLines(id), getProducts()]);
  const eligible = lines.filter((l) => l.matchType === "unmatched" && !l.productId);

  const results: CreateAndLinkResult[] = [];
  for (const line of eligible) {
    const fuzzy = matchLineItem(
      {
        rawDescription: line.rawDescription,
        upc: line.upc,
        brand: line.brand,
        name: line.name,
        size: line.size,
        concentration: line.concentration,
        quantity: line.expectedQty,
        unitCost: line.unitCost,
        lineTotal: line.lineTotal,
      },
      products
    );
    if (fuzzy.matchType === "fuzzy" && fuzzy.candidate) {
      results.push({
        lineId: line.id,
        status: "needs_review",
        error: `Possible match: ${fuzzy.candidate.brand} ${fuzzy.candidate.name} (${fuzzy.candidate.size})`,
      });
      continue;
    }
    // Sequential, not parallel — each call re-reads current PO lines, so
    // running them one at a time keeps every step's "is this still
    // eligible" check honest against what the previous iteration just wrote.
    results.push(await createAndLinkProductForLine(id, line.id));
  }

  return NextResponse.json({ results });
}
