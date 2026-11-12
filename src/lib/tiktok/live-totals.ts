import { toCents } from "./money";
import type { MatchHealth, SlotState } from "./records";

// Pure helpers for the Go Live TikTok panel (shared by the UI and the tests).
// PREVIEW ONLY: nothing here creates a SaleRecord, changes inventory, cost or profit.
// All money is computed in integer cents; TikTok prices are decimal strings.

export interface PanelRowLite {
  sellerSku: string;
  state: SlotState;
  salePrice: string | null;
  match: { productId: string; health: MatchHealth | null } | null;
}

export interface ProductLite {
  id: string;
  cost: number;
  inventory: number;
}

export interface PanelTotals {
  /** Matched, still-paid auctions only. */
  unitsMatched: number;
  revenueCents: number;
  /** Cost of matched products that have a cost on file. */
  costCents: number;
  /** Gross profit over matched rows that have a cost (revenue - cost). */
  profitCents: number;
  marginPct: number | null;
  matchedWithoutCost: number;
  unmatchedPaid: number;
  unmatchedPaidCents: number;
  /** Everything TikTok says is paid in this room, matched or not. */
  paidAuctions: number;
  paidCents: number;
  /** Cancelled / unpaid auctions — never in revenue or profit. */
  unpaid: number;
  /** A saved match whose TikTok order is no longer the paid one (cancelled / changed). Excluded. */
  staleMatches: number;
  /** A saved match whose AMORUH product no longer exists. Excluded. */
  missingProduct: number;
  /** How many counted rows use each product (to flag more matched than stock). */
  usage: Record<string, number>;
}

export const isPaidRow = (r: Pick<PanelRowLite, "state">) => r.state === "PAID";

export function computeTotals(rows: PanelRowLite[], products: Map<string, ProductLite>): PanelTotals {
  const t: PanelTotals = { unitsMatched: 0, revenueCents: 0, costCents: 0, profitCents: 0, marginPct: null, matchedWithoutCost: 0, unmatchedPaid: 0, unmatchedPaidCents: 0, paidAuctions: 0, paidCents: 0, unpaid: 0, staleMatches: 0, missingProduct: 0, usage: {} };
  let revenueWithCost = 0;
  for (const r of rows) {
    const cents = toCents(r.salePrice) ?? 0;
    if (!isPaidRow(r)) {
      t.unpaid++;
      if (r.match) t.staleMatches++; // a match exists on an auction that is not paid (any more)
      continue;
    }
    t.paidAuctions++;
    t.paidCents += cents;
    const m = r.match;
    if (!m) {
      t.unmatchedPaid++;
      t.unmatchedPaidCents += cents;
      continue;
    }
    if (m.health !== "OK") {
      t.staleMatches++;
      t.unmatchedPaid++;
      t.unmatchedPaidCents += cents;
      continue;
    }
    const p = products.get(m.productId);
    if (!p) {
      t.missingProduct++;
      t.unmatchedPaid++;
      t.unmatchedPaidCents += cents;
      continue;
    }
    t.unitsMatched++;
    t.revenueCents += cents;
    t.usage[p.id] = (t.usage[p.id] ?? 0) + 1;
    if (p.cost > 0) {
      t.costCents += Math.round(p.cost * 100);
      revenueWithCost += cents;
    } else t.matchedWithoutCost++;
  }
  t.profitCents = revenueWithCost - t.costCents;
  t.marginPct = revenueWithCost > 0 ? (t.profitCents / revenueWithCost) * 100 : null;
  return t;
}

export interface SearchableProduct {
  id: string;
  name: string;
  brand: string;
  sku: string;
  barcode: string;
  size?: string;
  inventory: number;
}

/** Typeahead over name / brand / SKU / barcode. Every typed word must match somewhere;
 *  exact SKU/barcode first, then name/brand prefix, in-stock before out-of-stock. */
export function searchProducts<T extends SearchableProduct>(products: T[], query: string, limit = 8): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const q = query.trim().toLowerCase();
  const scored: { p: T; score: number }[] = [];
  for (const p of products) {
    const sku = p.sku.toLowerCase(), bc = p.barcode.toLowerCase(), name = p.name.toLowerCase(), brand = p.brand.toLowerCase();
    const hay = `${brand} ${name} ${sku} ${bc} ${(p.size ?? "").toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    let score = 0;
    if (sku === q || bc === q) score += 1000;
    else if (sku.startsWith(q) || bc.startsWith(q)) score += 300;
    if (name.startsWith(q) || brand.startsWith(q) || `${brand} ${name}`.startsWith(q)) score += 100;
    if (p.inventory > 0) score += 50;
    scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
  return scored.slice(0, limit).map((s) => s.p);
}
