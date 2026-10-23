// LIVE Reorder Intelligence — pure scoring over historical LIVE sales.
//
// No Redis, no I/O: callers hand in the sessions + the sale rows (loaded from
// the existing SaleRecords by reorder-db.ts) and the current product list.
// Everything is DERIVED each time from those records; nothing is stored, so
// there is no second source of truth, and a cache/version layer can be added in
// front of computeReorderIntelligence later without touching this file.
//
// Rules (from the approved design):
//  - only active (non-canceled) sales count anywhere: units, GMV, cost, profit,
//    consistency, recommendations.
//  - profit uses each sale's own cost-at-sale snapshot, never today's cost.
//  - products aggregate by canonical productId — no fuzzy merging here.
//  - Demand and Profit are percentile ranks (robust to one expensive outlier);
//    Consistency is sessions-sold ÷ applicable LIVEs with an evidence ramp.
//  - missing cost => "Cost Unknown": profit left out, Demand+Consistency
//    re-scaled proportionally, flagged lower-confidence.
//  - negative total profit never reaches Hot + Profitable / the top of the list.

import {
  BUCKETS,
  CONSISTENCY_CONFIDENCE_BY_LIVES,
  COST_KNOWN_MIN_COVERAGE,
  FULL_CONFIDENCE_LIVES,
  LOSING_MONEY_SCORE_CAP,
  MIN_APPLICABLE_LIVES_FOR_CONFIDENCE,
  MIN_UNITS_FOR_CONFIDENCE,
  REORDER,
  SCORE_WEIGHTS,
  type WindowKey,
} from "./reorder-config";

export interface HistorySession {
  id: string;
  name: string;
  startedAt: string;
}

/** One sale row, exactly the SaleRecord fields analytics needs. */
export interface HistorySale {
  saleId: string;
  sessionId: string;
  productId: string;
  quantity: number;
  /** total price for all `quantity` units */
  price: number;
  /** per-unit landed cost frozen at sale time; null = no cost basis */
  landedCostAtSale: number | null;
  soldAt: string;
  status: string;
  liveOrderNumber: number | null;
}

export interface ProductCatalogRef {
  id: string;
  brand: string;
  name: string;
  size: string;
  sku: string;
  barcode: string;
  inventory: number;
}

export type Bucket =
  | "Hot + Profitable"
  | "High Demand / Thin Margin"
  | "High Demand / Losing Money"
  | "High Profit / Lower Frequency"
  | "Steady Seller"
  | "Weak Performer"
  | "Cost Unknown"
  | "New / Not Enough Data";

export type ConfidenceLevel = "low" | "medium" | "full";

export interface ScoreBreakdown {
  demand: number;
  /** null when cost is unknown (profit left out) */
  profit: number | null;
  consistency: number;
  /** weights actually applied after re-scaling, summing to 1 */
  weights: { demand: number; profit: number; consistency: number };
  /** score before the losing-money cap */
  uncapped: number;
  capped: boolean;
}

export interface ReorderRow {
  productId: string;
  name: string;
  sku: string;
  barcode: string;
  stock: number;
  units: number;
  gmv: number;
  /** cost of the costed sales only (null when none has a cost) */
  cost: number | null;
  profit: number | null;
  profitPerUnit: number | null;
  margin: number | null;
  avgSellingPrice: number;
  avgUnitCost: number | null;
  /** share of units that carry a cost snapshot, 0–1 */
  costCoverage: number;
  costUnknown: boolean;
  livesSold: number;
  applicableLives: number;
  /** ramped consistency, 0–100 */
  consistency: number;
  rawConsistency: number;
  confidence: ConfidenceLevel;
  avgUnitsPerLive: number;
  lastSoldAt: string;
  score: number;
  breakdown: ScoreBreakdown;
  bucket: Bucket;
  suggestedQty: number;
  suggestedReason: string;
  flag: string | null;
  warnings: string[];
}

export interface ReorderSummary {
  totalProfit: number;
  totalGmv: number;
  totalUnits: number;
  products: number;
  sessionsInWindow: number;
  topCandidates: ReorderRow[];
  mostConsistent: ReorderRow | null;
  highestProfitProduct: ReorderRow | null;
  /** sales in the window that carry no cost snapshot (their profit is not in totalProfit) */
  salesMissingCost: number;
}

export interface ReorderResult {
  window: WindowKey;
  sessions: HistorySession[];
  rows: ReorderRow[];
  summary: ReorderSummary;
  /** sold products whose names look alike but have separate product ids — reported, never merged */
  dataQuality: { lookAlikeGroups: { productIds: string[]; names: string[] }[]; deletedProductIds: string[] };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------

/** The sessions (oldest → newest, only those with at least one active sale)
 *  that fall inside the selected window. Each recorded session counts as one
 *  LIVE, even when one event was split in two. */
export function sessionsInWindow(sessionsWithSales: HistorySession[], window: WindowKey, now: Date = new Date()): HistorySession[] {
  const ordered = [...sessionsWithSales].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  switch (window) {
    case "last3":
      return ordered.slice(-3);
    case "last5":
      return ordered.slice(-5);
    case "last10":
      return ordered.slice(-10);
    case "7d":
    case "30d": {
      const days = window === "7d" ? 7 : 30;
      const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
      return ordered.filter((s) => s.startedAt >= cutoff);
    }
    default:
      return ordered;
  }
}

// ---------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------

/** Percentile rank 0–100 of each value among `values` (ties share their mean rank). */
export function percentileRanks(values: number[]): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [50];
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    const lo = sorted.indexOf(v);
    const hi = sorted.lastIndexOf(v);
    return (((lo + hi) / 2) / (sorted.length - 1)) * 100;
  });
}

export function consistencyConfidence(applicableLives: number): number {
  const i = Math.min(Math.max(applicableLives, 0), CONSISTENCY_CONFIDENCE_BY_LIVES.length - 1);
  return CONSISTENCY_CONFIDENCE_BY_LIVES[i];
}

function confidenceLevel(applicableLives: number): ConfidenceLevel {
  if (applicableLives >= FULL_CONFIDENCE_LIVES) return "full";
  return applicableLives >= 2 ? "medium" : "low";
}

interface Accumulator {
  productId: string;
  units: number;
  gmv: number;
  costedUnits: number;
  costedRevenue: number;
  costTotal: number;
  sessions: Map<string, number>; // sessionId -> units
  lastSoldAt: string;
  firstSessionIdx: number;
}

// ---------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------

export function computeReorderIntelligence(input: {
  sessions: HistorySession[];
  sales: HistorySale[];
  products: ProductCatalogRef[];
  window: WindowKey;
  now?: Date;
}): ReorderResult {
  const { products, window } = input;
  const activeSales = input.sales.filter((s) => s.status !== "canceled" && s.status !== "refunded");

  const sessionIdsWithSales = new Set(activeSales.map((s) => s.sessionId));
  const sessions = sessionsInWindow(
    input.sessions.filter((s) => sessionIdsWithSales.has(s.id)),
    window,
    input.now
  );
  const sessionIdx = new Map(sessions.map((s, i) => [s.id, i]));
  const productById = new Map(products.map((p) => [p.id, p]));

  // ---- aggregate by canonical productId ----
  const acc = new Map<string, Accumulator>();
  let salesMissingCost = 0;
  for (const sale of activeSales) {
    const idx = sessionIdx.get(sale.sessionId);
    if (idx === undefined) continue; // outside the window
    let a = acc.get(sale.productId);
    if (!a) {
      a = { productId: sale.productId, units: 0, gmv: 0, costedUnits: 0, costedRevenue: 0, costTotal: 0, sessions: new Map(), lastSoldAt: "", firstSessionIdx: idx };
      acc.set(sale.productId, a);
    }
    const qty = sale.quantity || 1;
    a.units += qty;
    a.gmv += sale.price;
    a.sessions.set(sale.sessionId, (a.sessions.get(sale.sessionId) ?? 0) + qty);
    if (sale.landedCostAtSale != null) {
      a.costedUnits += qty;
      a.costedRevenue += sale.price;
      a.costTotal += sale.landedCostAtSale * qty;
    } else {
      salesMissingCost++;
    }
    if (sale.soldAt > a.lastSoldAt) a.lastSoldAt = sale.soldAt;
    a.firstSessionIdx = Math.min(a.firstSessionIdx, idx);
  }

  const list = [...acc.values()];
  const n = sessions.length;

  // ---- per-product numbers ----
  const base = list.map((a) => {
    const p = productById.get(a.productId);
    const coverage = a.units > 0 ? a.costedUnits / a.units : 0;
    const costUnknown = coverage < COST_KNOWN_MIN_COVERAGE;
    const profit = a.costedUnits > 0 && !costUnknown ? r2(a.costedRevenue - a.costTotal) : null;
    const applicable = Math.max(1, n - a.firstSessionIdx);
    const raw = a.sessions.size / applicable;
    const confidence = consistencyConfidence(applicable);
    return {
      a,
      p,
      coverage,
      costUnknown,
      profit,
      applicable,
      rawConsistency: raw * 100,
      consistency: raw * confidence * 100,
      confidence: confidenceLevel(applicable),
    };
  });

  // Demand percentile among all products in the window; Profit percentile among
  // products whose cost is known (unknown-cost products never enter that ranking).
  const demandRanks = percentileRanks(base.map((b) => b.a.units));
  const knownIdx = base.map((b, i) => (b.profit !== null ? i : -1)).filter((i) => i >= 0);
  const profitRanksKnown = percentileRanks(knownIdx.map((i) => base[i].profit as number));
  const profitRank = new Map<number, number>(knownIdx.map((i, k) => [i, profitRanksKnown[k]]));

  const rows: ReorderRow[] = base.map((b, i) => {
    const { a, p } = b;
    const demand = demandRanks[i];
    const profitScore = profitRank.get(i) ?? null;
    const w = SCORE_WEIGHTS;
    const weights =
      profitScore === null
        ? { demand: w.demand / (w.demand + w.consistency), profit: 0, consistency: w.consistency / (w.demand + w.consistency) }
        : { demand: w.demand, profit: w.profit, consistency: w.consistency };
    const uncapped = weights.demand * demand + weights.profit * (profitScore ?? 0) + weights.consistency * b.consistency;
    const losing = b.profit !== null && b.profit < 0;
    const score = losing ? Math.min(uncapped, LOSING_MONEY_SCORE_CAP) : uncapped;

    const costKnownUnits = a.costedUnits;
    const profit = b.profit;
    const margin = profit !== null && a.costedRevenue > 0 ? profit / a.costedRevenue : null;
    const profitPerUnit = profit !== null && costKnownUnits > 0 ? profit / costKnownUnits : null;
    const avgUnitsPerLive = a.units / b.applicable;

    const enough = a.units >= MIN_UNITS_FOR_CONFIDENCE && b.applicable >= MIN_APPLICABLE_LIVES_FOR_CONFIDENCE;
    const bucket = classify({ enough, costUnknown: b.costUnknown, profit, margin, profitPerUnit, demand, profitScore, consistency: b.consistency });

    const stock = p?.inventory ?? 0;
    const reorder = suggestQty({ bucket, avgUnitsPerLive, consistency: b.consistency, stock, unitsInWindow: a.units });

    const warnings: string[] = [];
    if (b.costUnknown) warnings.push("Cost unknown — profit is left out of the score, so this ranking is lower-confidence.");
    else if (b.coverage < 1) warnings.push(`Profit is based on the ${Math.round(b.coverage * 100)}% of units that have a recorded cost.`);
    if (b.confidence === "low") warnings.push("Only 1 LIVE of history — consistency is low-confidence.");
    else if (b.confidence === "medium") warnings.push("Limited history — consistency is medium-confidence.");
    if (bucket === "High Demand / Losing Money") {
      warnings.push("Sells often but loses money: improve supplier cost, raise the auction floor, or lower reorder priority.");
    }

    return {
      productId: a.productId,
      name: p ? `${p.brand} ${p.name}${p.size ? ` ${p.size}` : ""}`.trim() : `(removed product) ${a.productId}`,
      sku: p?.sku ?? "",
      barcode: p?.barcode ?? "",
      stock,
      units: a.units,
      gmv: r2(a.gmv),
      cost: a.costedUnits > 0 ? r2(a.costTotal) : null,
      profit,
      profitPerUnit: profitPerUnit === null ? null : r2(profitPerUnit),
      margin,
      avgSellingPrice: r2(a.gmv / a.units),
      avgUnitCost: a.costedUnits > 0 ? r2(a.costTotal / a.costedUnits) : null,
      costCoverage: b.coverage,
      costUnknown: b.costUnknown,
      livesSold: a.sessions.size,
      applicableLives: b.applicable,
      consistency: r2(b.consistency),
      rawConsistency: r2(b.rawConsistency),
      confidence: b.confidence,
      avgUnitsPerLive: r2(avgUnitsPerLive),
      lastSoldAt: a.lastSoldAt,
      score: Math.round(score),
      breakdown: { demand: Math.round(demand), profit: profitScore === null ? null : Math.round(profitScore), consistency: Math.round(b.consistency), weights, uncapped: Math.round(uncapped), capped: losing && uncapped > LOSING_MONEY_SCORE_CAP },
      bucket,
      suggestedQty: reorder.qty,
      suggestedReason: reorder.reason,
      flag: stockFlag(score, bucket, stock, p !== undefined),
      warnings,
    };
  });

  rows.sort((x, y) => y.score - x.score || y.units - x.units);

  const eligibleTop = rows.filter((r) => isReorderCandidate(r));
  const profitable = rows.filter((r) => r.profit !== null);
  const summary: ReorderSummary = {
    totalProfit: r2(rows.reduce((s, r) => s + (r.profit ?? 0), 0)),
    totalGmv: r2(rows.reduce((s, r) => s + r.gmv, 0)),
    totalUnits: rows.reduce((s, r) => s + r.units, 0),
    products: rows.length,
    sessionsInWindow: n,
    topCandidates: eligibleTop.slice(0, 5),
    mostConsistent:
      [...rows].filter((r) => r.applicableLives >= MIN_APPLICABLE_LIVES_FOR_CONFIDENCE).sort((x, y) => y.consistency - x.consistency || y.units - x.units)[0] ?? null,
    highestProfitProduct: [...profitable].sort((x, y) => (y.profit as number) - (x.profit as number))[0] ?? null,
    salesMissingCost,
  };

  return { window, sessions, rows, summary, dataQuality: findLookAlikes(rows.map((r) => r.productId), productById) };
}

/** A real reorder candidate: enough data, known profit that isn't negative, not weak. */
export function isReorderCandidate(r: ReorderRow): boolean {
  return (
    r.bucket !== "New / Not Enough Data" &&
    r.bucket !== "High Demand / Losing Money" &&
    r.bucket !== "Weak Performer" &&
    !(r.profit !== null && r.profit < 0)
  );
}

function classify(x: {
  enough: boolean;
  costUnknown: boolean;
  profit: number | null;
  margin: number | null;
  profitPerUnit: number | null;
  demand: number;
  profitScore: number | null;
  consistency: number;
}): Bucket {
  if (!x.enough) return "New / Not Enough Data";
  if (x.costUnknown) return "Cost Unknown";
  const losing = x.profit !== null && x.profit < 0;
  if (losing) return x.demand >= BUCKETS.losingMoneyDemandMin ? "High Demand / Losing Money" : "Weak Performer";
  const profitS = x.profitScore ?? 0;
  if (
    x.demand >= BUCKETS.hotDemandMin &&
    profitS >= BUCKETS.hotProfitMin &&
    x.consistency >= BUCKETS.hotConsistencyMin &&
    (x.margin ?? 0) >= BUCKETS.hotMinMargin
  ) {
    return "Hot + Profitable";
  }
  if (
    x.demand >= BUCKETS.thinMarginDemandMin &&
    ((x.margin !== null && x.margin < BUCKETS.thinMarginMaxMargin) || (x.profitPerUnit !== null && x.profitPerUnit < BUCKETS.thinMarginMaxProfitPerUnit))
  ) {
    return "High Demand / Thin Margin";
  }
  if (profitS >= BUCKETS.highProfitMin) return "High Profit / Lower Frequency";
  if (x.consistency >= BUCKETS.steadyConsistencyMin && (x.margin ?? 0) >= BUCKETS.steadyMinMargin) return "Steady Seller";
  return "Weak Performer";
}

function suggestQty(x: { bucket: Bucket; avgUnitsPerLive: number; consistency: number; stock: number; unitsInWindow: number }): { qty: number; reason: string } {
  if (x.bucket === "New / Not Enough Data") return { qty: 0, reason: "Not enough history for a confident recommendation." };
  if (x.bucket === "High Demand / Losing Money") return { qty: 0, reason: "No reorder suggested while it loses money — improve cost or raise the floor first." };
  if (x.bucket === "Weak Performer") return { qty: 0, reason: "Weak demand and/or profit — no reorder suggested." };
  const factor = REORDER.consistencyFloor + (1 - REORDER.consistencyFloor) * (x.consistency / 100);
  const expected = x.avgUnitsPerLive * REORDER.horizonLives * factor;
  let qty = Math.max(0, Math.ceil(expected - x.stock));
  if (REORDER.capAtUnitsSoldInWindow) qty = Math.min(qty, x.unitsInWindow);
  const reason =
    `Average ${x.avgUnitsPerLive.toFixed(1)} units/LIVE × ${REORDER.horizonLives} expected LIVEs × ${factor.toFixed(2)} (consistency)` +
    ` = ${expected.toFixed(1)}, minus ${x.stock} in stock` +
    (REORDER.capAtUnitsSoldInWindow && qty === x.unitsInWindow ? `, capped at the ${x.unitsInWindow} sold in this period` : "");
  return { qty, reason };
}

function stockFlag(score: number, bucket: Bucket, stock: number, exists: boolean): string | null {
  if (!exists) return null;
  const strong = bucket === "Hot + Profitable" || bucket === "Steady Seller" || bucket === "High Profit / Lower Frequency";
  if (!strong || score < 60) return null;
  if (stock === 0) return "Strong seller — currently out of stock";
  if (stock <= 2) return `Strong reorder candidate — only ${stock} remaining`;
  return null;
}

/** Sold products with look-alike names but separate ids: reported, never combined. */
function findLookAlikes(ids: string[], productById: Map<string, ProductCatalogRef>) {
  const norm = (p: ProductCatalogRef) =>
    `${p.brand} ${p.name} ${p.size}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(new|tester|edp|edt)\b/g, "").replace(/\s+/g, " ").trim();
  const groups = new Map<string, ProductCatalogRef[]>();
  const deleted: string[] = [];
  for (const id of ids) {
    const p = productById.get(id);
    if (!p) {
      deleted.push(id);
      continue;
    }
    groups.set(norm(p), [...(groups.get(norm(p)) ?? []), p]);
  }
  return {
    lookAlikeGroups: [...groups.values()].filter((g) => g.length > 1).map((g) => ({ productIds: g.map((p) => p.id), names: g.map((p) => `${p.brand} ${p.name} ${p.size}`.trim()) })),
    deletedProductIds: deleted,
  };
}

// ---------------------------------------------------------------------
// Drill-down: every LIVE a product sold in
// ---------------------------------------------------------------------

export interface DrilldownSession {
  sessionId: string;
  sessionName: string;
  startedAt: string;
  units: number;
  avgPrice: number;
  /** average per-unit cost snapshot of the costed units; null if none */
  avgUnitCost: number | null;
  profit: number | null;
  gmv: number;
  orders: { saleId: string; liveOrderNumber: number | null; quantity: number; price: number; landedCostAtSale: number | null; soldAt: string }[];
}

export function drilldownForProduct(input: { productId: string; sessions: HistorySession[]; sales: HistorySale[]; window: WindowKey; now?: Date }): DrilldownSession[] {
  const withSales = new Set(input.sales.filter((s) => s.status !== "canceled" && s.status !== "refunded").map((s) => s.sessionId));
  const win = sessionsInWindow(input.sessions.filter((s) => withSales.has(s.id)), input.window, input.now);
  const inWin = new Map(win.map((s) => [s.id, s]));
  const bySession = new Map<string, HistorySale[]>();
  for (const sale of input.sales) {
    if (sale.productId !== input.productId || sale.status === "canceled" || sale.status === "refunded" || !inWin.has(sale.sessionId)) continue;
    bySession.set(sale.sessionId, [...(bySession.get(sale.sessionId) ?? []), sale]);
  }
  return [...bySession.entries()]
    .map(([sessionId, sales]) => {
      const s = inWin.get(sessionId)!;
      const units = sales.reduce((a, x) => a + x.quantity, 0);
      const gmv = sales.reduce((a, x) => a + x.price, 0);
      const costed = sales.filter((x) => x.landedCostAtSale != null);
      const costedUnits = costed.reduce((a, x) => a + x.quantity, 0);
      const cost = costed.reduce((a, x) => a + (x.landedCostAtSale as number) * x.quantity, 0);
      const costedRev = costed.reduce((a, x) => a + x.price, 0);
      return {
        sessionId,
        sessionName: s.name,
        startedAt: s.startedAt,
        units,
        avgPrice: r2(gmv / units),
        avgUnitCost: costedUnits > 0 ? r2(cost / costedUnits) : null,
        profit: costedUnits > 0 ? r2(costedRev - cost) : null,
        gmv: r2(gmv),
        orders: sales
          .map((x) => ({ saleId: x.saleId, liveOrderNumber: x.liveOrderNumber, quantity: x.quantity, price: x.price, landedCostAtSale: x.landedCostAtSale, soldAt: x.soldAt }))
          .sort((a, b) => a.soldAt.localeCompare(b.soldAt)),
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
