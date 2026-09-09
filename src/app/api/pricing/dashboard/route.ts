import { NextResponse } from "next/server";
import { getRecentUploads, getMatchReviewSummary, getCurrentGenerationSeq } from "@/lib/pricing-db";
import { getSuppliers } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// GET /api/pricing/dashboard — the Pricing/Ordering overview screen's
// summary numbers.
//
// "Review Required" is now genuinely just needs_review + alias_conflict
// + barcode_conflict — it used to secretly include New Product
// Candidates too (a 6,000+-row supplier catalog with a 75-product
// AMORUH catalog showed "11,654 need a decision" right next to a "New
// Product Candidates: 11,255" card showing nearly the same number
// again). Both counts also now exclude delisted (currentlyListed:
// false) offers — see pricing-db.ts's getMatchReviewSummary.
export async function GET() {
  const [uploads, matchReview, suppliers] = await Promise.all([getRecentUploads(20), getMatchReviewSummary(), getSuppliers()]);

  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const uploadsToday = uploads.filter((u) => new Date(u.startedAt).getTime() >= oneDayAgo).length;

  const liveFlags = await Promise.all(
    uploads.map(async (u) => (await getCurrentGenerationSeq(u.supplierId)) === u.seq)
  );

  return NextResponse.json({
    uploadsToday,
    recentUploads: uploads.slice(0, 10).map((u, i) => ({ ...u, isLive: liveFlags[i] })),
    matchReview: {
      reviewRequired: matchReview.reviewRequired,
      newCandidates: matchReview.newCandidates,
      matched: matchReview.matched,
      bySupplier: matchReview.bySupplier,
    },
    supplierCount: suppliers.length,
  });
}
