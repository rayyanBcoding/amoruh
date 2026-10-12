import type { Product } from "./types";

// ---------------------------------------------------------------------
// Eligibility for the researched selling-reference system
// (scripts/enrich-fragrance-selling-notes.ts). Deliberately content-
// based, not timestamp-based: a product that was already attempted but
// came back without usable content (no confident identification, or a
// research/API failure) must stay eligible for a future re-attempt —
// checking sellingNotesResearchedAt alone would permanently skip it
// after one inconclusive try. Out-of-stock products are never eligible,
// per spec — research spend only ever goes toward what's actually
// stocked right now.
// ---------------------------------------------------------------------

export function hasCompleteSellingReference(
  p: Pick<Product, "sellingKeyNotes" | "sellingQuickLine">
): boolean {
  return Boolean(p.sellingKeyNotes && p.sellingKeyNotes.length > 0 && p.sellingQuickLine && p.sellingQuickLine.trim().length > 0);
}

export function needsSellingNotesResearch(
  p: Pick<Product, "inventory" | "sellingKeyNotes" | "sellingQuickLine">
): boolean {
  if (p.inventory <= 0) return false;
  return !hasCompleteSellingReference(p);
}
