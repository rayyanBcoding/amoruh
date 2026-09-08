import clsx from "clsx";
import type { ReviewStatus } from "@/lib/pricing-types";

const REVIEW_STYLES: Record<ReviewStatus, string> = {
  auto_matched: "bg-ld-green/15 text-ld-green ring-ld-green/40",
  confirmed: "bg-ld-green/15 text-ld-green ring-ld-green/40",
  needs_review: "bg-ld-amber/15 text-ld-amber ring-ld-amber/40",
  new_candidate: "bg-ld-cyan/15 text-ld-cyan ring-ld-cyan/40",
  alias_conflict: "bg-ld-red/15 text-ld-red ring-ld-red/40",
  barcode_conflict: "bg-ld-red/15 text-ld-red ring-ld-red/40",
  ignored: "bg-ld-border/40 text-ld-muted ring-ld-border",
};

const REVIEW_LABELS: Record<ReviewStatus, string> = {
  auto_matched: "Auto-Matched",
  confirmed: "Confirmed",
  needs_review: "Needs Review",
  new_candidate: "New Product Candidate",
  alias_conflict: "Alias Conflict — Review Required",
  barcode_conflict: "Barcode Conflict — Review Required",
  ignored: "Ignored",
};

export function ReviewStatusBadge({ status, confidence }: { status: ReviewStatus; confidence?: number | null }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ring-inset",
        REVIEW_STYLES[status]
      )}
    >
      {REVIEW_LABELS[status]}
      {confidence != null && ` · ${Math.round(confidence * 100)}%`}
    </span>
  );
}

export function ListedBadge({ currentlyListed, quantity }: { currentlyListed: boolean; quantity: number | null }) {
  if (!currentlyListed) {
    return (
      <span className="inline-flex items-center rounded-full bg-ld-border/40 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ld-muted ring-1 ring-inset ring-ld-border">
        No Longer Listed
      </span>
    );
  }
  if (quantity !== null && quantity <= 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-ld-amber/15 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ld-amber ring-1 ring-inset ring-ld-amber/40">
        Out of Stock
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-ld-green/15 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ld-green ring-1 ring-inset ring-ld-green/40">
      In Stock
    </span>
  );
}

export function StaleBadge({ isStale, ageDays }: { isStale: boolean; ageDays: number }) {
  if (!isStale) return null;
  return (
    <span
      title={`Last updated ${ageDays} day${ageDays === 1 ? "" : "s"} ago`}
      className="ml-1.5 inline-flex items-center rounded-full bg-ld-red/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ld-red ring-1 ring-inset ring-ld-red/30"
    >
      Stale
    </span>
  );
}
