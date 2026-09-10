// Go Live — domain types.
//
// Additive to the existing catalog/sales model (src/lib/types.ts,
// src/lib/sales-analytics.ts) and Inventory Intake model
// (src/lib/intake-types.ts). Nothing here duplicates Product, inventory,
// cost, or supplier data — a LiveSession/LivePresentation only ever
// references those by id. See the approved plan
// (linear-drifting-eclipse.md) for the full design rationale.

export type LiveSessionStatus = "active" | "ended";

export interface LiveSession {
  id: string;
  name: string;
  status: LiveSessionStatus;
  operator: string;
  startedAt: string;
  endedAt: string | null;
}

/** High-frequency, per-session operational state — kept in its own key
 *  from LiveSession's identity fields so a scan/queue-edit never rewrites
 *  session metadata. Deliberately NOT the old global LiveState: there is
 *  no `flashDeal`/fixed live price here — Go Live runs live auctions, so
 *  every sale's price comes from RECORD SALE's winning-bid input, never
 *  a stored "current" price. "Recent sales" is intentionally NOT cached
 *  here — it's derived by reading this session's LivePresentations
 *  (already needed for stats) and resolving their linked SaleRecords, so
 *  there's nothing here that could drift from the real ledger. */
export interface LiveSessionState {
  sessionId: string;
  currentProductId: string | null;
  queueIds: string[];
}

export type PresentationOutcome = "sold" | "no_sale";

/** One auction attempt. Created atomically, already resolved, the moment
 *  an operator clicks RECORD SALE or NO SALE — scanning/loading a
 *  product, or advancing past it with NEXT ITEM without resolving it,
 *  never creates one (see the approved plan's presentation-timing
 *  finding). `outcome` is never rewritten after creation, including when
 *  the linked sale is later canceled — "effectively sold" is always
 *  computed at read time as `outcome === "sold" && linkedSale.status !==
 *  "canceled"`, so cancellation is honestly audit-preserved rather than
 *  rewriting history. */
export interface LivePresentation {
  id: string;
  liveSessionId: string;
  productId: string;
  sku: string;
  outcome: PresentationOutcome;
  /** Meaningful only when outcome === "sold". */
  quantity: number;
  /** Set when outcome === "sold"; null for a no_sale presentation. */
  saleId: string | null;
  timestamp: string;
  operator: string;
}

/** One small, operator-editable settings record Break-Even reads from.
 *  Every field starts unset — see computeBreakEven() in
 *  sales-analytics.ts, which returns "not_configured" until
 *  platformFeePercent AND paymentFeePercent are both explicitly set.
 *  shippingSubsidy/packagingCost default to 0 (a valid, explicit value)
 *  rather than being required. */
export interface SellingConfig {
  platformFeePercent: number | null;
  paymentFeePercent: number | null;
  shippingSubsidy: number;
  packagingCost: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

export function defaultSellingConfig(): SellingConfig {
  return {
    platformFeePercent: null,
    paymentFeePercent: null,
    shippingSubsidy: 0,
    packagingCost: 0,
    updatedAt: null,
    updatedBy: null,
  };
}

export type BreakEvenResult =
  | { status: "not_configured" }
  | { status: "ok"; breakEven: number };

/** Derived, never stored — Live Time / Presented / Units Sold / Revenue /
 *  Est. Gross Profit / Sell-Through for one session, computed fresh from
 *  its LivePresentations + linked SaleRecords. See getSessionStats() in
 *  live-db.ts. */
export interface LiveSessionStats {
  sessionId: string;
  liveTimeMs: number;
  productsPresented: number;
  unitsSold: number;
  revenue: number;
  costOfGoods: number;
  estimatedGrossProfit: number | null;
  /** effectively-sold presentations / (effectively-sold + no_sale) — see
   *  the approved plan's sell-through definition. Null when there have
   *  been zero completed presentations yet (never displayed as 0%). */
  presentationSellThrough: number | null;
  noSaleCount: number;
  /** Average Auction / Average Winning Bid — completedRevenue / soldPresentationCount. */
  averageAuction: number | null;
  averageSellingPricePerUnit: number | null;
  highestAuction: number | null;
  topProductId: string | null;
}

/** Explicit customer-safe allowlist — the ONLY shape ever sent to the TV
 *  Display surface. Never derived by hiding fields in the UI from a
 *  larger object; see toTVProduct() in src/lib/tv.ts. Deliberately
 *  excludes cost, landed cost, break-even, shelf, supplier, and internal
 *  notes. Customer-facing fragrance notes/profile and the existing
 *  retail/market/loot list prices ARE included — those were already
 *  documented as customer-facing on Product (see types.ts) and are
 *  unrelated to the Go Live operator-only financial block (Cost,
 *  Break-Even, Last Sold, Avg Auction). */
export interface TVProduct {
  id: string;
  brand: string;
  name: string;
  image: string;
  color: string;
  size: string;
  concentration: string;
  retailPrice: number;
  marketPrice: number;
  lootPrice: number;
  fragranceNotes: string[];
  projection: string;
  longevity: string;
  authentic: boolean;
}
