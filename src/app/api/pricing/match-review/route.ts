import { NextResponse } from "next/server";
import { getMatchReviewQueue } from "@/lib/pricing-db";

export const dynamic = "force-dynamic";

// GET /api/pricing/match-review — every offer currently needing a human
// decision (needs_review, new_candidate, alias_conflict, barcode_conflict).
export async function GET() {
  const items = await getMatchReviewQueue();
  return NextResponse.json({
    items,
    counts: {
      total: items.length,
      needsReview: items.filter((i) => i.reviewStatus === "needs_review").length,
      newCandidates: items.filter((i) => i.reviewStatus === "new_candidate").length,
      aliasConflicts: items.filter((i) => i.reviewStatus === "alias_conflict").length,
      barcodeConflicts: items.filter((i) => i.reviewStatus === "barcode_conflict").length,
    },
  });
}
