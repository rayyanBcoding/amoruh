import { redis } from "./kv";
import { getProduct, patchState } from "./db";
import { getLotsWithRemaining, newId } from "./intake-db";
import { computeWeightedAverageLandedCost } from "./intake-costing";
import {
  cancelSale as cancelSaleRecord,
  computeAverageAuction,
  correctSalePrice as correctSalePriceRecord,
  getLastSoldPrice,
  getSaleRecordById,
  presentationKey,
  presentationsBySessionZsetKey,
  recordNoSale as recordNoSaleRecord,
  recordSale as recordSaleRecord,
  type SaleRecord,
} from "./sales-analytics";
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
  activeSessionId: "amoruh:live:active_session_id",
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

// KEYS[1] active_session_id pointer
// KEYS[2] session key
// KEYS[3] sessions_index zset
// KEYS[4] session_state key
// ARGV[1] sessionId
// ARGV[2] new session (JSON)
// ARGV[3] score (startedAt ms)
// ARGV[4] new session_state (JSON)
//
// SETNX-shaped: if a session is already active, this makes NO writes and
// returns its id — the caller treats that as "resumed," never an error.
// Two tabs racing here can't both create a session: only the one whose
// script runs first ever sees KEYS[1] unset.
const START_LIVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  return current
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
redis.call('SET', KEYS[4], ARGV[4])
return ARGV[1]
`;

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

  const keys = [KEYS.activeSessionId, KEYS.session(id), KEYS.sessionsIndex, KEYS.sessionState(id)];
  const args = [id, JSON.stringify(session), String(Date.now()), JSON.stringify(state)];

  const resultId = await redis.eval<(string | number)[], string>(START_LIVE_SCRIPT, keys, args);
  const resolved = await getSession(resultId);
  if (!resolved) throw new Error("Failed to start or resume a Live Session.");
  return resolved;
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
const END_LIVE_SCRIPT = `
local raw = redis.call('GET', KEYS[2])
if not raw then
  return 'NOT_FOUND'
end
local session = cjson.decode(raw)
if session.status == 'ended' then
  return raw
end
redis.call('SET', KEYS[2], ARGV[2])
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  redis.call('DEL', KEYS[1])
end
return ARGV[2]
`;

export async function endLiveSession(sessionId: string): Promise<LiveSession> {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Live Session not found.");

  const updated: LiveSession = { ...session, status: "ended", endedAt: session.endedAt ?? new Date().toISOString() };
  const keys = [KEYS.activeSessionId, KEYS.session(sessionId)];
  const args = [sessionId, JSON.stringify(updated)];

  const result = await redis.eval<(string | number)[], string>(END_LIVE_SCRIPT, keys, args);
  if (result === "NOT_FOUND") throw new Error("Live Session not found.");
  return JSON.parse(result) as LiveSession;
}

/** Newest-first session history for the Entry Screen / Live History list. */
export async function getRecentSessions(limit = 20): Promise<LiveSession[]> {
  const ids = (await redis.zrange(KEYS.sessionsIndex, 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const sessions = await Promise.all(ids.map((id) => getSession(id)));
  return sessions.filter((s): s is LiveSession => s !== null);
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
}

export async function goLiveRecordSale(input: GoLiveRecordSaleInput) {
  return recordSaleRecord({
    liveSessionId: input.sessionId,
    productId: input.productId,
    quantity: input.quantity,
    winningBid: input.winningBid,
    operator: input.operator,
    idempotencyKey: input.idempotencyKey,
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

// ---------------------------------------------------------------------
// Recent sales / presentations for a session — always derived from the
// presentations_by_session zset + linked SaleRecords, never a separately
// cached list (see LiveSessionState's doc comment).
// ---------------------------------------------------------------------

export interface SessionPresentationView {
  presentation: LivePresentation;
  sale: SaleRecord | null;
}

export async function getPresentationsForSession(sessionId: string, limit = 200): Promise<SessionPresentationView[]> {
  const ids = (await redis.zrange(presentationsBySessionZsetKey(sessionId), 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const presentations = await Promise.all(ids.map((id) => redis.get<LivePresentation>(presentationKey(id))));
  const views = await Promise.all(
    presentations.map(async (p) => {
      if (!p) return null;
      const sale = p.saleId ? await getSaleRecordById(p.saleId) : null;
      return { presentation: p, sale } satisfies SessionPresentationView;
    })
  );
  return views.filter((v): v is SessionPresentationView => v !== null);
}

/** A presentation counts as "effectively sold" only while its linked sale
 *  is still `completed` — a canceled sale's presentation is excluded from
 *  BOTH the sold and no-sale buckets entirely (see the approved plan's
 *  sell-through definition: a cancellation is treated as if the auction
 *  attempt itself never resolved, not as a fabricated "no sale"). */
function isEffectivelySold(view: SessionPresentationView): boolean {
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
  const hasCompleteCostData = sold.length > 0 && sold.every((v) => v.sale?.landedCostAtSale !== null);
  const costOfGoods = hasCompleteCostData
    ? sold.reduce((sum, v) => sum + (v.sale!.landedCostAtSale as number) * (v.sale!.quantity ?? 0), 0)
    : 0;

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

  return {
    sessionId,
    liveTimeMs,
    productsPresented: views.length,
    unitsSold,
    revenue,
    costOfGoods,
    estimatedGrossProfit: hasCompleteCostData ? revenue - costOfGoods : null,
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
