import { NextResponse } from "next/server";
import { getRecentUploads, getMatchReviewSummary, getCurrentGenerationSeq } from "@/lib/pricing-db";
import { getSuppliers } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// GET /api/pricing/dashboard — the Pricing/Ordering overview screen's
// summary numbers.
//
// "Review Required" is genuinely just needs_review + alias_conflict +
// barcode_conflict, excluding delisted (currentlyListed: false) offers
// — see pricing-db.ts's getMatchReviewSummary. There is no "New Product
// Candidates" concept: "no existing match" resolves immediately into
// matched (auto-created) or review_required at processing time, never a
// separate queue (see pricing-process.ts). "New Master Product created"
// is an audit event, not a status — recentAutoCreated below is exactly
// that, a rolling count across the recent uploads shown, not a call to
// action.
export async function GET() {
  const [uploads, matchReview, suppliers] = await Promise.all([getRecentUploads(20), getMatchReviewSummary(), getSuppliers()]);

  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const uploadsToday = uploads.filter((u) => new Date(u.startedAt).getTime() >= oneDayAgo).length;
  const recentAutoCreated = uploads.reduce((sum, u) => sum + (u.autoCreated ?? 0), 0);

  const liveFlags = await Promise.all(
    uploads.map(async (u) => (await getCurrentGenerationSeq(u.supplierId)) === u.seq)
  );

  return NextResponse.json({
    uploadsToday,
    recentAutoCreated,
    recentUploads: uploads.slice(0, 10).map((u, i) => ({ ...u, isLive: liveFlags[i] })),
    matchReview: {
      reviewRequired: matchReview.reviewRequired,
      matched: matchReview.matched,
      bySupplier: matchReview.bySupplier,
    },
    supplierCount: suppliers.length,
  });
}
