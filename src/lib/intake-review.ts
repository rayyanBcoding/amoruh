import type { PurchaseOrderLine } from "./intake-types";

// ---------------------------------------------------------------------
// A PO line's "confirmed" state is computed live, never stored — same
// philosophy as landed cost and lot remaining elsewhere in Intake Mode.
//
// A line only counts as confirmed when its productId is set AND that
// product still exists right now. A line whose match has gone stale
// (the product it pointed to was since deleted) is NOT confirmed — it
// needs a human to re-match it, exactly like a line that was never
// matched at all. This is what closes the gap where a dangling
// productId used to slip past Receive All's gate (truthy but pointing
// at nothing) and get silently skipped with no feedback.
//
// Nothing here needs a migration or a new stored field: re-matching a
// line (the same "Match to product…" action PO Detail already offers)
// is the repair path for both a never-matched line and a stale one.
// ---------------------------------------------------------------------

export interface POReviewSummary {
  total: number;
  confirmed: number;
  unresolvedLineIds: string[];
}

export function isLineConfirmed(line: PurchaseOrderLine, existingProductIds: ReadonlySet<string>): boolean {
  return Boolean(line.productId) && existingProductIds.has(line.productId as string);
}

export function computePOReviewSummary(
  lines: PurchaseOrderLine[],
  existingProductIds: ReadonlySet<string>
): POReviewSummary {
  const unresolvedLineIds = lines.filter((l) => !isLineConfirmed(l, existingProductIds)).map((l) => l.id);
  return {
    total: lines.length,
    confirmed: lines.length - unresolvedLineIds.length,
    unresolvedLineIds,
  };
}
