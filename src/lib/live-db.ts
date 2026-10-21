import { redis } from "./kv";
import { getProduct, getProducts, patchState } from "./db";
import { getLotsWithRemaining, newId } from "./intake-db";
import { claimActiveSession, REAL_ACTIVE_KEY } from "./live-mode-guard";
import { computeWeightedAverageLandedCost } from "./intake-costing";
import { computeSessionProfit } from "./session-profit";
import {
  cancelSale as cancelSaleRecord,
  computeAverageAuction,
  correctSalePrice as correctSalePriceRecord,
  deriveSaleFinancials,
  editSale as editSaleRecord,
  getLastSoldPrice,
  getSaleAudit,
  getSaleRecordById,
  presentationKey,
  presentationsBySessionZsetKey,
  recordNoSale as recordNoSaleRecord,
  recordSale as recordSaleRecord,
  restoreSale as restoreSaleRecord,
  normalizeSaleRecord,
  saleKeyOf,
  type SaleAuditEvent,
  type SaleRecord,
} from "./sales-analytics";
import type { Product } from "./types";
import type {
  BreakEvenResult,
  LivePresentation,
  LiveSession,
  LiveSessionState,
  LiveSessionStats,
  SellingConfig,
} from "./live-types";
import { defaultSellingConfig } from "./live-types";

// ---------------------------------------------------------------------
// Go Live session storage. Same "single pointer + collection" shape
// already proven out for Pricing/Ordering's generations: one hash per
// session, one zset index for history, one pointer key enforcing "only
// one active session at a time." Session identity (this file) is kept
// separate from high-frequency operational state (currentProductId,
// queueIds — also this file, its own key) so a scan/queue edit never
// rewrites session metadata, and separate again from sales/presentations
// (sales-analytics.ts), which are the actual source of truth for
// everything money- or inventory-related. This file only ever
// REFERENCES products/inventory/cost by id — see db.ts/intake-db.ts for
// the one real copy of that data.
// ---------------------------------------------------------------------

const KEYS = {
  // Same literal `claimActiveSession` (live-mode-guard.ts) uses as
  // REAL_ACTIVE_KEY — imported rather than duplicated so there's one
  // source of truth for it.
  activeSessionId: REAL_ACTIVE_KEY,
  session: (id: string) => `amoruh:live:session:${id}`,
  sessionsIndex: "amoruh:live:sessions_index",
  sessionState: (id: string) => `amoruh:live:session_state:${id}`,
  sellingConfig: "amoruh:live:selling_config",
} as const;

function defaultSessionState(sessionId: string): LiveSessionState {
  return { sessionId, currentProductId: null, queueIds: [] };
}

// ---------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------

// Claiming the pointer, writing the session/state/index, and refusing a
// competing Test Live are now all one atomic step — see
// claimActiveSession() in live-mode-guard.ts for why a plain "GET the
// test pointer, then SETNX my own" would race.
export async function startLiveSession(name: string | undefined, operator: string): Promise<LiveSession> {
  const id = newId("live");
  const startedAt = new Date().toISOString();
  const session: LiveSession = {
    id,
    name: name?.trim() || defaultSessionName(startedAt),
    status: "active",
    operator: operator?.trim() || "Unknown",
    startedAt,
    endedAt: null,
  };
  const state = defaultSessionState(id);

  const result = await claimActiveSession({
    mode: "real",
    sessionKey: KEYS.session(id),
    sessionsIndexKey: KEYS.sessionsIndex,
    sessionStateKey: KEYS.sessionState(id),
    sessionId: id,
    sessionJSON: JSON.stringify(session),
    score: String(Date.now()),
    stateJSON: JSON.stringify(state),
  });

  if (result.claimed) return session;
  if ("existingSessionId" in result) {
    const resolved = await getSession(result.existingSessionId);
    if (!resolved) throw new Error("Failed to resume the active Live Session.");
    return resolved;
  }
  throw new Error("A Test Live is currently active — end it before starting a real Live.");
}

function defaultSessionName(startedAtIso: string): string {
  const d = new Date(startedAtIso);
  const datePart = d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const hour = d.getHours();
  const part = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  return `${datePart} ${part} Live`;
}

export async function getSession(id: string): Promise<LiveSession | null> {
  return (await redis.get<LiveSession>(KEYS.session(id))) ?? null;
}

export async function getActiveSessionId(): Promise<string | null> {
  return (await redis.get<string>(KEYS.activeSessionId)) ?? null;
}

export async function getActiveSession(): Promise<LiveSession | null> {
  const id = await getActiveSessionId();
  if (!id) return null;
  return getSession(id);
}

export async function getSessionState(sessionId: string): Promise<LiveSessionState> {
  return (await redis.get<LiveSessionState>(KEYS.sessionState(sessionId))) ?? defaultSessionState(sessionId);
}

/** Plain read-modify-write — this is display/operational convenience
 *  state (which product is current, what's queued), not money- or
 *  inventory-affecting, so it doesn't need the CAS treatment recordSale/
 *  cancelSale get. A lost update here (two racing scans) just means the
 *  loser's scan doesn't stick, which self-corrects the moment the
 *  operator scans/selects again — nothing to reconcile. */
export async function patchSessionState(
  sessionId: string,
  patch: Partial<Omit<LiveSessionState, "sessionId">>
): Promise<LiveSessionState> {
  const current = await getSessionState(sessionId);
  const next: LiveSessionState = { ...current, ...patch, sessionId };
  await redis.set(KEYS.sessionState(sessionId), next);
  return next;
}

// KEYS[1] active_session_id pointer
// KEYS[2] session key
// ARGV[1] sessionId
// ARGV[2] new session (JSON, status "ended")
//
// Idempotent by construction: if the session is already ended, returns
// its existing (unchanged) record instead of re-stamping endedAt. Clears
// the active pointer in the SAME script as the status flip, so a crash
// mid-way can never leave "ended" with the pointer still aimed at it, or
// vice versa.
// Returns a bare status word, never the session JSON itself — Upstash's
// client auto-deserializes any returned value that parses as JSON, so a
// script returning the full session object would come back to the JS
// caller already-parsed into an object, not the string this code used to
// (wrongly) JSON.parse() again. The caller already has (or can re-fetch)
// the actual session data; the script's only job is the atomic
// status-flip + pointer-clear.
const END_LIVE_SCRIPT = `
local raw = redis.call('GET', KEYS[2])
if not raw then
  return 'NOT_FOUND'
end
local session = cjson.decode(raw)
if session.status == 'ended' then
  return 'ALREADY_ENDED'
end
redis.call('SET', KEYS[2], ARGV[2])
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
end
return 'OK'
`;

export async function endLiveSession(sessionId: string): Promise<LiveSession> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Live Session not found.");

  const updated: LiveSession = { ...session, status: "ended", endedAt: session.endedAt ?? new Date().toISOString() };
  const keys = [KEYS.activeSessionId, KEYS.session(sessionId)];
  const args = [sessionId, JSON.stringify(updated)];

  const result = await redis.eval<(string | number)[], string>(END_LIVE_SCRIPT, keys, args);
  if (result === "NOT_FOUND") throw new Error("Live Session not found.");
  if (result === "ALREADY_ENDED") {
    const latest = await getSession(sessionId);
    return latest ?? updated;
  }
  return updated;
}

/** Newest-first session history for the Entry Screen / Live History list. */
export async function getRecentSessions(limit = 20): Promise<LiveSession[]> {
  const ids = (await redis.zrange(KEYS.sessionsIndex, 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const sessions = await Promise.all(ids.map((id) => getSession(id)));
  return sessions.filter((s): s is LiveSession => s !== null);
}

/** Dashboard's "Last Live" card — the most recently ENDED session,
 *  period. Deliberately independent of any analytics timeframe filter
 *  and never the currently-active session (an in-progress Live is Go
 *  Live's own concern, surfaced separately as a "Live Now" indicator —
 *  see the approved Dashboard plan). Walks recent history until it finds
 *  one that's actually ended, so an active session never masks the true
 *  last-completed one. */
export async function getLastCompletedSession(): Promise<LiveSession | null> {
  const ids = (await redis.zrange(KEYS.sessionsIndex, 0, 19, { rev: true })) as string[];
  for (const id of ids) {
    const session = await getSession(id);
    if (session && session.status === "ended") return session;
  }
  return null;
}

// ---------------------------------------------------------------------
// Current product / TV compatibility hook
//
// Go Live's own queue/current-product state (above) is the operational
// source of truth. TV Display is a pre-existing surface that already
// polls the OLD global LiveState (src/lib/db.ts) — rather than build TV
// a whole new sync channel, Go Live's product-changing actions also
// shadow-write LiveState.currentProductId, which is the "small
// integration hook" the Go Live spec explicitly allows without rebuilding
// TV Display. TV itself only ever renders the explicit customer-safe
// allowlist (see src/lib/tv.ts) — this shadow-write only carries an id,
// never the sensitive fields, so it doesn't reopen the payload gap it
// fixed.
// ---------------------------------------------------------------------

export async function setCurrentProductForTV(productId: string | null): Promise<void> {
  await patchState({ currentProductId: productId });
}

// ---------------------------------------------------------------------
// Sale / presentation actions — thin session-aware wrappers around
// sales-analytics.ts's atomic primitives. This file adds nothing to the
// atomicity story here; it only resolves session/product context and
// forwards.
// ---------------------------------------------------------------------

export interface GoLiveRecordSaleInput {
  sessionId: string;
  productId: string;
  quantity: number;
  winningBid: number;
  operator: string;
  idempotencyKey: string;
  allowOversell?: boolean;
}

export async function goLiveRecordSale(input: GoLiveRecordSaleInput) {
  return recordSaleRecord({
    liveSessionId: input.sessionId,
    productId: input.productId,
    quantity: input.quantity,
    winningBid: input.winningBid,
    operator: input.operator,
    idempotencyKey: input.idempotencyKey,
    allowOversell: input.allowOversell,
  });
}

export interface GoLiveNoSaleInput {
  sessionId: string;
  productId: string;
  operator: string;
  idempotencyKey: string;
}

export async function goLiveRecordNoSale(input: GoLiveNoSaleInput) {
  const product = await getProduct(input.productId);
  if (!product) throw new Error("Product not found.");
  return recordNoSaleRecord({
    liveSessionId: input.sessionId,
    productId: input.productId,
    sku: product.sku,
    operator: input.operator,
    idempotencyKey: input.idempotencyKey,
  });
}

export const goLiveCancelSale = cancelSaleRecord;
export const goLiveCorrectSalePrice = correctSalePriceRecord;
export const goLiveEditSale = editSaleRecord;
export const goLiveRestoreSale = restoreSaleRecord;

// ---------------------------------------------------------------------
// Live Order Ledger — the complete, searchable list of a session's orders.
//
// There is no second order store: an order IS a SaleRecord, found through the
// session's existing presentations index (never the capped recent list). Two
// batched reads (presentations, then their sales) + one catalog read, and the
// page is cut from that in memory — bounded by the size of ONE Live, with no
// catalog scan and no rewrite of any session blob.
// ---------------------------------------------------------------------

export interface OrderLedgerProduct {
  id: string;
  brand: string;
  name: string;
  size: string;
  sku: string;
  barcode: string;
  image: string;
}

export interface OrderLedgerRow {
  sale: SaleRecord;
  product: OrderLedgerProduct | null;
  financials: ReturnType<typeof deriveSaleFinancials>;
  /** "active" is a SaleRecord with status "completed". */
  status: "active" | "canceled";
}

export type OrderLedgerStatusFilter = "all" | "active" | "canceled";

export interface OrderLedgerQuery {
  q?: string;
  status?: OrderLedgerStatusFilter;
  offset?: number;
  limit?: number;
}

export interface OrderLedgerPage {
  sessionId: string;
  rows: OrderLedgerRow[];
  /** rows matching the search + status filter (before paging) */
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  /** whole-session counts, independent of the filter */
  counts: { entered: number; active: number; canceled: number };
}

const LEDGER_MAX_ORDERS = 5000;

function toLedgerProduct(p: Product | undefined): OrderLedgerProduct | null {
  return p ? { id: p.id, brand: p.brand, name: p.name, size: p.size, sku: p.sku, barcode: p.barcode, image: p.image } : null;
}

function compareOrdersNewestFirst(a: SaleRecord, b: SaleRecord): number {
  if (a.liveOrderNumber != null && b.liveOrderNumber != null) return b.liveOrderNumber - a.liveOrderNumber;
  const byTime = b.soldAt.localeCompare(a.soldAt);
  return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
}

/** True when the search text hits this row; `exactOrder` marks a #N exact hit. */
function matchOrder(row: OrderLedgerRow, rawQuery: string): { hit: boolean; exactOrder: boolean } {
  const trimmed = rawQuery.trim();
  const orderOnly = trimmed.startsWith("#"); // "#73" means the LIVE Order number, nothing else
  const q = trimmed.replace(/^#/, "").trim().toLowerCase();
  if (!q) return { hit: true, exactOrder: false };
  const number = row.sale.liveOrderNumber;
  const numeric = /^\d+$/.test(q);
  const exactOrder = numeric && number != null && String(number) === q;
  const partialOrder = numeric && number != null && String(number).includes(q);
  if (orderOnly) return { hit: exactOrder || partialOrder, exactOrder };
  const p = row.product;
  const text = p ? `${p.brand} ${p.name} ${p.size}`.toLowerCase() : "";
  const textHit =
    text.includes(q) ||
    (row.sale.sku ?? "").toLowerCase().includes(q) ||
    (p?.sku ?? "").toLowerCase().includes(q) ||
    (p?.barcode ?? "").toLowerCase().includes(q);
  return { hit: exactOrder || partialOrder || textHit, exactOrder };
}

export async function getSessionOrderLedger(sessionId: string, query: OrderLedgerQuery = {}): Promise<OrderLedgerPage> {
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200);
  const offset = Math.max(Math.floor(query.offset ?? 0), 0);
  const status = query.status ?? "all";

  const [views, products] = await Promise.all([getPresentationsForSession(sessionId, LEDGER_MAX_ORDERS), getProducts()]);
  const productById = new Map(products.map((p) => [p.id, p]));

  const rows: OrderLedgerRow[] = views
    .filter((v) => v.presentation.outcome === "sold" && v.sale !== null)
    .map((v) => {
      const sale = v.sale as SaleRecord;
      return {
        sale,
        product: toLedgerProduct(productById.get(sale.productId)),
        financials: deriveSaleFinancials(sale),
        status: sale.status === "canceled" ? ("canceled" as const) : ("active" as const),
      };
    })
    .sort((a, b) => compareOrdersNewestFirst(a.sale, b.sale));

  const counts = {
    entered: rows.length,
    active: rows.filter((r) => r.status === "active").length,
    canceled: rows.filter((r) => r.status === "canceled").length,
  };

  const matched: { row: OrderLedgerRow; exact: boolean }[] = [];
  for (const row of rows) {
    if (status !== "all" && row.status !== status) continue;
    const m = matchOrder(row, query.q ?? "");
    if (m.hit) matched.push({ row, exact: m.exactOrder });
  }
  // an exact LIVE Order # (e.g. "73") always floats to the top; everything else keeps newest-first
  const ordered = [...matched.filter((m) => m.exact), ...matched.filter((m) => !m.exact)].map((m) => m.row);

  const page = ordered.slice(offset, offset + limit);
  return { sessionId, rows: page, total: ordered.length, offset, limit, hasMore: offset + limit < ordered.length, counts };
}

export interface OrderDetail {
  row: OrderLedgerRow;
  session: LiveSession | null;
  /** false once the Live has ended — the order is then read-only */
  editable: boolean;
  audit: SaleAuditEvent[];
}

export async function getOrderDetail(saleId: string): Promise<OrderDetail | null> {
  const sale = await getSaleRecordById(saleId);
  if (!sale) return null;
  const [product, session, audit] = await Promise.all([
    getProduct(sale.productId),
    sale.liveSessionId ? getSession(sale.liveSessionId) : Promise.resolve(null),
    getSaleAudit(saleId),
  ]);
  return {
    row: {
      sale,
      product: toLedgerProduct(product ?? undefined),
      financials: deriveSaleFinancials(sale),
      status: sale.status === "canceled" ? "canceled" : "active",
    },
    session,
    editable: session ? session.status === "active" : false,
    audit,
  };
}

// ---------------------------------------------------------------------
// Recent sales / presentations for a session — always derived from the
// presentations_by_session zset + linked SaleRecords, never a separately
// cached list (see LiveSessionState's doc comment).
// ---------------------------------------------------------------------

export interface SessionPresentationView {
  presentation: LivePresentation;
  sale: SaleRecord | null;
}

const MGET_CHUNK = 500;

async function mgetAll<T>(keys: string[]): Promise<(T | null)[]> {
  const out: (T | null)[] = [];
  for (let i = 0; i < keys.length; i += MGET_CHUNK) {
    out.push(...(await redis.mget<(T | null)[]>(...keys.slice(i, i + MGET_CHUNK))));
  }
  return out;
}

export async function getPresentationsForSession(sessionId: string, limit = 200): Promise<SessionPresentationView[]> {
  const ids = (await redis.zrange(presentationsBySessionZsetKey(sessionId), 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  // two batched reads (presentations, then their sales) instead of one GET per record
  const presentations = await mgetAll<LivePresentation>(ids.map((id) => presentationKey(id)));
  const present = presentations.filter((p): p is LivePresentation => p !== null);
  const saleIds = present.map((p) => p.saleId).filter((id): id is string => Boolean(id));
  const sales = await mgetAll<SaleRecord>(saleIds.map((id) => saleKeyOf(id)));
  const saleById = new Map<string, SaleRecord>();
  sales.forEach((sale, i) => {
    if (sale) saleById.set(saleIds[i], normalizeSaleRecord(sale));
  });
  return present.map((p) => ({ presentation: p, sale: p.saleId ? saleById.get(p.saleId) ?? null : null }));
}

/** A presentation counts as "effectively sold" only while its linked sale
 *  is still `completed` — a canceled sale's presentation is excluded from
 *  BOTH the sold and no-sale buckets entirely (see the approved plan's
 *  sell-through definition: a cancellation is treated as if the auction
 *  attempt itself never resolved, not as a fabricated "no sale"). */
export function isEffectivelySold(view: SessionPresentationView): boolean {
  return view.presentation.outcome === "sold" && view.sale !== null && view.sale.status === "completed";
}

export async function getSessionStats(sessionId: string): Promise<LiveSessionStats> {
  const [session, views] = await Promise.all([getSession(sessionId), getPresentationsForSession(sessionId, 2000)]);
  if (!session) throw new Error("Live Session not found.");

  const liveTimeMs = (session.endedAt ? new Date(session.endedAt).getTime() : Date.now()) - new Date(session.startedAt).getTime();
  const noSaleCount = views.filter((v) => v.presentation.outcome === "no_sale").length;
  const sold = views.filter(isEffectivelySold);

  const unitsSold = sold.reduce((sum, v) => sum + (v.sale?.quantity ?? 0), 0);
  const revenue = sold.reduce((sum, v) => sum + (v.sale?.price ?? 0), 0);
  const { costOfGoods, estimatedGrossProfit, ordersMissingCost, costedRevenue } = computeSessionProfit(
    sold.map((v) => ({ price: v.sale?.price ?? 0, quantity: v.sale?.quantity, landedCostAtSale: v.sale?.landedCostAtSale }))
  );

  const revenueByProduct = new Map<string, number>();
  for (const v of sold) {
    const pid = v.presentation.productId;
    revenueByProduct.set(pid, (revenueByProduct.get(pid) ?? 0) + (v.sale?.price ?? 0));
  }
  let topProductId: string | null = null;
  let topRevenue = -Infinity;
  for (const [pid, rev] of revenueByProduct) {
    if (rev > topRevenue) {
      topRevenue = rev;
      topProductId = pid;
    }
  }

  const completedPresentations = sold.length + noSaleCount;

  // Live Order Ledger counts: a canceled order stays "entered" but contributes
  // nothing to units/revenue/cost/profit (those only read `sold`).
  const canceledOrders = views.filter((v) => v.presentation.outcome === "sold" && v.sale?.status === "canceled").length;

  return {
    sessionId,
    liveTimeMs,
    productsPresented: views.length,
    unitsSold,
    revenue,
    costOfGoods,
    estimatedGrossProfit,
    enteredOrders: sold.length + canceledOrders,
    activeOrders: sold.length,
    canceledOrders,
    // margin on the orders that have a cost, so uncosted revenue doesn't distort it
    grossMargin: estimatedGrossProfit !== null && costedRevenue > 0 ? estimatedGrossProfit / costedRevenue : null,
    ordersMissingCost,
    presentationSellThrough: completedPresentations > 0 ? sold.length / completedPresentations : null,
    noSaleCount,
    averageAuction: sold.length > 0 ? revenue / sold.length : null,
    averageSellingPricePerUnit: unitsSold > 0 ? revenue / unitsSold : null,
    highestAuction: sold.length > 0 ? Math.max(...sold.map((v) => v.sale?.price ?? 0)) : null,
    topProductId,
  };
}

// ---------------------------------------------------------------------
// Break-even selling-cost configuration
// ---------------------------------------------------------------------

export async function getSellingConfig(): Promise<SellingConfig> {
  return (await redis.get<SellingConfig>(KEYS.sellingConfig)) ?? defaultSellingConfig();
}

export interface UpdateSellingConfigInput {
  platformFeePercent?: number | null;
  paymentFeePercent?: number | null;
  shippingSubsidy?: number;
  packagingCost?: number;
  operator: string;
}

export class SellingConfigError extends Error {}

export async function updateSellingConfig(input: UpdateSellingConfigInput): Promise<SellingConfig> {
  const current = await getSellingConfig();
  const next: SellingConfig = {
    platformFeePercent: input.platformFeePercent !== undefined ? input.platformFeePercent : current.platformFeePercent,
    paymentFeePercent: input.paymentFeePercent !== undefined ? input.paymentFeePercent : current.paymentFeePercent,
    shippingSubsidy: input.shippingSubsidy !== undefined ? input.shippingSubsidy : current.shippingSubsidy,
    packagingCost: input.packagingCost !== undefined ? input.packagingCost : current.packagingCost,
    updatedAt: new Date().toISOString(),
    updatedBy: input.operator?.trim() || "Unknown",
  };

  for (const [label, value] of [
    ["Platform fee %", next.platformFeePercent],
    ["Payment fee %", next.paymentFeePercent],
  ] as const) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new SellingConfigError(`${label} must be zero or greater.`);
    }
  }
  for (const [label, value] of [
    ["Shipping subsidy", next.shippingSubsidy],
    ["Packaging cost", next.packagingCost],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      // V1 deliberately does not support negative shipping/packaging
      // values (a rebate/credit would need its own explicitly-named
      // field later) — see the approved plan's break-even cleanup note.
      throw new SellingConfigError(`${label} cannot be negative.`);
    }
  }
  const variableFeeRate = ((next.platformFeePercent ?? 0) + (next.paymentFeePercent ?? 0)) / 100;
  if (variableFeeRate >= 1) {
    throw new SellingConfigError("Platform fee % + Payment fee % must be less than 100%.");
  }

  await redis.set(KEYS.sellingConfig, next);
  return next;
}

export interface CurrentProductFinancials {
  cost: number | null;
  /** "weighted_landed" — real lot-based cost data exists (preferred).
   *  "legacy" — no lot data at all; falling back to the product's own
   *  `cost` field, labeled distinctly per the approved plan's costing
   *  finding. "unavailable" — neither exists; never silently shown as 0. */
  costSource: "weighted_landed" | "legacy" | "unavailable";
  breakEven: BreakEvenResult;
  lastSoldPrice: number | null;
  averageAuction: number | null;
}

/** The Go Live operator-only financial block for the current product:
 *  COST (weighted-avg landed cost, falling back to legacy Product.cost
 *  only when there's no lot data at all), BREAK-EVEN, LAST SOLD, AVG
 *  AUCTION. Never guesses — see computeBreakEven and the Accuracy
 *  Requirement in the approved plan. */
export async function getProductFinancials(productId: string, legacyCost: number): Promise<CurrentProductFinancials> {
  const lots = await getLotsWithRemaining(productId);
  const weighted = computeWeightedAverageLandedCost(lots);
  const cost = weighted ?? (legacyCost > 0 ? legacyCost : null);
  const costSource: CurrentProductFinancials["costSource"] =
    weighted !== null ? "weighted_landed" : legacyCost > 0 ? "legacy" : "unavailable";

  const sellingConfig = await getSellingConfig();
  const breakEven: BreakEvenResult = cost !== null ? computeBreakEven(cost, sellingConfig) : { status: "not_configured" };

  const [lastSoldPrice, auctionStats] = await Promise.all([getLastSoldPrice(productId), computeAverageAuction(productId)]);

  return { cost, costSource, breakEven, lastSoldPrice, averageAuction: auctionStats.averageAuction };
}

/** breakEven = (cost + fixedSellingCosts) / (1 - variableFeeRate).
 *  Percentage fees are charged on the FULL selling price, including the
 *  portion needed to recover fixed per-unit costs — dividing by
 *  (1 - variableFeeRate) rather than adding fixed costs outside the
 *  division is what makes this correct (see the approved plan's
 *  break-even correction). Returns "not_configured" — never a guessed
 *  number — until an operator has explicitly entered BOTH fee
 *  percentages; shipping/packaging may validly stay at their 0 default. */
export function computeBreakEven(cost: number, config: SellingConfig): BreakEvenResult {
  if (config.platformFeePercent === null || config.paymentFeePercent === null) {
    return { status: "not_configured" };
  }
  const variableFeeRate = (config.platformFeePercent + config.paymentFeePercent) / 100;
  if (variableFeeRate >= 1) return { status: "not_configured" };
  const fixedSellingCosts = config.shippingSubsidy + config.packagingCost;
  return { status: "ok", breakEven: (cost + fixedSellingCosts) / (1 - variableFeeRate) };
}
