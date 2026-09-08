import { NextResponse } from "next/server";
import { getRecentUploads, getMatchReviewQueue, getCurrentGenerationSeq } from "@/lib/pricing-db";
import { getSuppliers } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// GET /api/pricing/dashboard — the Pricing/Ordering overview screen's
// summary numbers (spec §33, Phase 1A subset: uploads + match review).
export async function GET() {
  const [uploads, matchReview, suppliers] = await Promise.all([getRecentUploads(20), getMatchReviewQueue(), getSuppliers()]);

  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const uploadsToday = uploads.filter((u) => new Date(u.startedAt).getTime() >= oneDayAgo).length;

  // An upload only counts as "live" if its seq matches the supplier's
  // currently-committed seq — a late-finishing/superseded upload is
  // completed but not current (see pricing-process.ts).
  const liveFlags = await Promise.all(
    uploads.map(async (u) => (await getCurrentGenerationSeq(u.supplierId)) === u.seq)
  );

  return NextResponse.json({
    uploadsToday,
    recentUploads: uploads.slice(0, 10).map((u, i) => ({ ...u, isLive: liveFlags[i] })),
    matchReview: {
      total: matchReview.length,
      needsReview: matchReview.filter((i) => i.reviewStatus === "needs_review").length,
      newCandidates: matchReview.filter((i) => i.reviewStatus === "new_candidate").length,
      aliasConflicts: matchReview.filter((i) => i.reviewStatus === "alias_conflict").length,
      barcodeConflicts: matchReview.filter((i) => i.reviewStatus === "barcode_conflict").length,
    },
    supplierCount: suppliers.length,
  });
}
