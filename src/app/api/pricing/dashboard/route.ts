import { NextResponse } from "next/server";
import { getRecentUploads, getUploadsForSupplier, getMatchReviewSummary, getCurrentGenerationSeq } from "@/lib/pricing-db";
import { getSuppliers } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// A supplier feed going quiet for a week is worth flagging even though
// individual OFFER freshness uses a 14-day threshold elsewhere
// (DEFAULT_FRESHNESS_THRESHOLD_DAYS, pricing-db.ts) -- this is a
// separate, deliberately shorter cadence check on the SUPPLIER's own
// upload habit, not on any one offer's price.
const FRESHNESS_ATTENTION_DAYS = 7;

// GET /api/pricing/dashboard — the Pricing/Ordering overview screen's
// summary numbers.
//
// "Review Required" is ACTIONABLE work only — alias_conflict/
// barcode_conflict (always active), plus any needs_review item an
// operator or workflow has explicitly flagged via reviewRequestedAt.
// It is NOT every ambiguous supplier-catalog item; most of those will
// never be purchased and forcing a human decision on all of them
// defeats the purpose of deferring work until it matters (Sep 2026
// scoping change). unresolvedOffers is the full, unfiltered count of
// ambiguous offers — a quiet, informational total the UI must never
// treat as a required task queue. Both exclude delisted
// (currentlyListed: false) offers — see pricing-db.ts's
// getMatchReviewSummary/isActiveReviewRequired. There is no "New
// Product Candidates" concept either: "no existing match" resolves
// immediately into matched (auto-created) or a genuinely-ambiguous
// offer at processing time (see pricing-process.ts). "New Master
// Product created" is an audit event, not a status — recentAutoCreated
// below is exactly that, a rolling count across the recent uploads
// shown, not a call to action.
export async function GET() {
  const [uploads, matchReview, suppliers] = await Promise.all([getRecentUploads(20), getMatchReviewSummary(), getSuppliers()]);

  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const uploadsToday = uploads.filter((u) => new Date(u.startedAt).getTime() >= oneDayAgo).length;
  const recentAutoCreated = uploads.reduce((sum, u) => sum + (u.autoCreated ?? 0), 0);

  const liveFlags = await Promise.all(
    uploads.map(async (u) => (await getCurrentGenerationSeq(u.supplierId)) === u.seq)
  );

  // Freshness panel: each supplier's own most recent SUCCESSFULLY
  // COMMITTED (status "completed" AND currently the live generation)
  // price sheet -- never a failed/superseded upload, which would
  // misrepresent an abandoned or overwritten attempt as "current."
  // Queried per-supplier (not sliced from the global top-20 recent
  // uploads) so a quieter supplier's real last commit is never pushed
  // out of view by other suppliers' more frequent uploads.
  const perSupplierUploads = await Promise.all(suppliers.map((s) => getUploadsForSupplier(s.id, 20)));
  const freshness = await Promise.all(
    suppliers.map(async (s, i) => {
      const currentSeq = await getCurrentGenerationSeq(s.id);
      const lastCommitted = perSupplierUploads[i].find((u) => u.status === "completed" && u.seq === currentSeq);
      if (!lastCommitted || !lastCommitted.completedAt) {
        return { supplierId: s.id, supplierName: s.name, filename: null, completedAt: null, daysSinceLastCommit: null, status: "never" as const };
      }
      const daysSince = (Date.now() - new Date(lastCommitted.completedAt).getTime()) / (1000 * 60 * 60 * 24);
      return {
        supplierId: s.id,
        supplierName: s.name,
        filename: lastCommitted.filename,
        completedAt: lastCommitted.completedAt,
        daysSinceLastCommit: Math.round(daysSince * 10) / 10,
        status: daysSince > FRESHNESS_ATTENTION_DAYS ? ("stale" as const) : ("current" as const),
      };
    })
  );

  return NextResponse.json({
    uploadsToday,
    recentAutoCreated,
    recentUploads: uploads.slice(0, 10).map((u, i) => ({ ...u, isLive: liveFlags[i] })),
    matchReview: {
      reviewRequired: matchReview.reviewRequired,
      unresolvedOffers: matchReview.unresolvedOffers,
      quietlyUnresolved: matchReview.quietlyUnresolved,
      matched: matchReview.matched,
      bySupplier: matchReview.bySupplier,
    },
    supplierCount: suppliers.length,
    freshness,
  });
}
