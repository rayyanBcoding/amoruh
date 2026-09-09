import { NextResponse } from "next/server";
import { getMatchReviewItems, getMatchReviewSummary } from "@/lib/pricing-db";
import type { MatchReviewBucket } from "@/lib/pricing-types";

export const dynamic = "force-dynamic";

const VALID_BUCKETS: MatchReviewBucket[] = ["review_required", "new_candidates", "matched"];

// GET /api/pricing/match-review?bucket=review_required|new_candidates|matched&supplierId=&search=&limit=&offset=
//
// Operates ONLY on currently-listed offers (see pricing-db.ts) and
// always returns the full per-supplier summary alongside the requested
// page, so the UI never needs a second round-trip just for header
// numbers. Defaults to "review_required" — the genuinely urgent bucket
// — never the flat, unfiltered everything-at-once list this replaces.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const bucketParam = url.searchParams.get("bucket") ?? "review_required";
  const bucket = VALID_BUCKETS.includes(bucketParam as MatchReviewBucket) ? (bucketParam as MatchReviewBucket) : "review_required";
  const supplierId = url.searchParams.get("supplierId") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  const [summary, page] = await Promise.all([
    getMatchReviewSummary(),
    getMatchReviewItems({ bucket, supplierId, search, limit, offset }),
  ]);

  const nextOffset = offset + page.items.length < page.total ? offset + page.items.length : null;

  return NextResponse.json({ items: page.items, total: page.total, nextOffset, summary });
}
