import { redis } from "./kv";
import { getProduct } from "./db";
import { getLotsWithRemaining } from "./intake-db";
import { computeWeightedAverageLandedCost } from "./intake-costing";
import { checkIdempotencyFast, idempotencyKeyOf } from "./atomic-write";
import { claimActiveSession, TEST_ACTIVE_KEY } from "./live-mode-guard";
import {
  defaultSellingConfig,
  type BreakEvenResult,
  type LivePresentation,
  type LiveSession,
  type LiveSessionStats,
  type SellingConfig,
} from "./live-types";
import type { SaleRecord } from "./sales-analytics";
import type { Product } from "./types";

// ---------------------------------------------------------------------
// TEST LIVE MODE — a complete, storage-isolated mirror of Go Live for
// operational rehearsal. Every function in this file may READ real
// Product/InventoryLot data; NONE of them ever write to it, and none of
// them import a production mutation function — that is enforced by the
// import list above, not by convention:
//
//   - No import of markProductSold / recordSale / recordNoSale /
//     cancelSale / correctSalePrice (sales-analytics.ts) — only
//     `SaleRecord`'s TYPE is imported, via `import type`, which is
//     erased at compile time and creates zero runtime dependency on
//     that module.
//   - No import of saveProducts / updateProduct / createProduct /
//     deleteProduct (db.ts) — only the read-only `getProduct`.
//   - No import of anything from intake-receiving.ts or any write path
//     of intake-db.ts — only the read-only `getLotsWithRemaining`.
//   - No import of live-db.ts AT ALL, even for a pure helper — live-db.ts
//     itself imports the real recordSale/cancelSale/etc. from
//     sales-analytics.ts, so importing anything from it (even one pure
//     function) would pull that whole module graph into this file's
//     dependency tree and quietly undermine the guarantee above. Two
//     small pieces of logic that DO conceptually match live-db.ts
//     (`isEffectivelySold`, `computeBreakEven`) are duplicated locally
//     below instead — a few lines each, and worth it for an honest
//     import graph.
//
// Storage is a fully separate namespace (`amoruh:testlive:*`) from real
// Go Live's `amoruh:live:*` / `amoruh:sales:*` — dashboard-db.ts and
// live-db.ts contain no reference to it at all, so exclusion from
// production Dashboard/analytics is structural, not a filter.
// ---------------------------------------------------------------------

const KEYS = {
  // Same literal claimActiveSession (live-mode-guard.ts) uses as
  // TEST_ACTIVE_KEY — imported rather than duplicated.
  activeSessionId: TEST_ACTIVE_KEY,
  session: (id: string) => `amoruh:testlive:session:${id}`,
  sessionsIndex: "amoruh:testlive:sessions_index",
  sessionState: (id: string) => `amoruh:testlive:session_state:${id}`,
  sale: (id: string) => `amoruh:testlive:sale:${id}`,
  salesBySession: (id: string) => `amoruh:testlive:sales_by_session:${id}`,
  presentation: (id: string) => `amoruh:testlive:presentation:${id}`,
  presentationsBySession: (id: string) => `amoruh:testlive:presentations_by_session:${id}`,
} as const;

function newTestId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function defaultTestSessionName(startedAtIso: string): string {
  const d = new Date(startedAtIso);
  const datePart = d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const hour = d.getHours();
  const part = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  return `${datePart} ${part} Test Live`;
}

/** The one genuinely new shape this feature needs — real LiveSessionState
 *  has no equivalent. `simulatedInventory` is populated lazily (see
 *  resolveSimulatedProduct) the first time a product is touched in this
 *  session; every later touch reads/writes only this map, never a fresh
 *  real read. */
export interface TestLiveSessionState {
  sessionId: string;
  currentProductId: string | null;
  queueIds: string[];
  simulatedInventory: Record<string, { startingInventory: number; simulatedInventory: number }>;
}

function defaultTestSessionState(sessionId: string): TestLiveSessionState {
  return { sessionId, currentProductId: null, queueIds: [], simulatedInventory: {} };
}

// ---------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------

export async function startTestLiveSession(name: string | undefined, operator: string): Promise<LiveSession> {
  const id = newTestId("test");
  const startedAt = new Date().toISOString();
  const session: LiveSession = {
    id,
    name: name?.trim() || defaultTestSessionName(startedAt),
    status: "active",
    operator: operator?.trim() || "Unknown",
    startedAt,
    endedAt: null,
  };
  const state = defaultTestSessionState(id);

  const result = await claimActiveSession({
    mode: "test",
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
    const resolved = await getTestSession(result.existingSessionId);
    if (!resolved) throw new Error("Failed to resume the active Test Live session.");
    return resolved;
  }
  throw new Error("A real Live is currently active — end it before starting a Test Live.");
}

export async function getTestSession(id: string): Promise<LiveSession | null> {
  return (await redis.get<LiveSession>(KEYS.session(id))) ?? null;
}

export async function getActiveTestSessionId(): Promise<string | null> {
  return (await redis.get<string>(KEYS.activeSessionId)) ?? null;
}

export async function getActiveTestSession(): Promise<LiveSession | null> {
  const id = await getActiveTestSessionId();
  if (!id) return null;
  return getTestSession(id);
}

export async function getRecentTestSessions(limit = 20): Promise<LiveSession[]> {
  const ids = (await redis.zrange(KEYS.sessionsIndex, 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const sessions = await Promise.all(ids.map((id) => getTestSession(id)));
  return sessions.filter((s): s is LiveSession => s !== null);
}

export async function getTestSessionState(sessionId: string): Promise<TestLiveSessionState> {
  return (await redis.get<TestLiveSessionState>(KEYS.sessionState(sessionId))) ?? defaultTestSessionState(sessionId);
}

/** Plain read-modify-write — same reasoning as the real
 *  `patchSessionState`: this is operational convenience state (current
 *  product, queue), not something a lost update could corrupt in a way
 *  that matters — a re-scan self-corrects it. */
export async function patchTestSessionState(
  sessionId: string,
  patch: Partial<Omit<TestLiveSessionState, "sessionId" | "simulatedInventory">>
): Promise<TestLiveSessionState> {
  const current = await getTestSessionState(sessionId);
  const next: TestLiveSessionState = { ...current, ...patch, sessionId };
  await redis.set(KEYS.sessionState(sessionId), next);
  return next;
}

// KEYS[1] test active pointer
// KEYS[2] test session key
// ARGV[1] sessionId
// ARGV[2] new session (JSON, status "ended")
//
// Returns a bare status word, never the session JSON — see the
// JSON-auto-parse note in live-mode-guard.ts. Idempotent: ending an
// already-ended session is a no-op, never a new endedAt.
const END_TEST_LIVE_SCRIPT = `
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

async function endTestSessionRecordOnly(sessionId: string): Promise<LiveSession> {
  const session = await getTestSession(sessionId);
  if (!session) throw new Error("Test Live session not found.");
  const updated: LiveSession = { ...session, status: "ended", endedAt: session.endedAt ?? new Date().toISOString() };
  const keys = [KEYS.activeSessionId, KEYS.session(sessionId)];
  const args = [sessionId, JSON.stringify(updated)];
  const result = await redis.eval<(string | number)[], string>(END_TEST_LIVE_SCRIPT, keys, args);
  if (result === "NOT_FOUND") throw new Error("Test Live session not found.");
  if (result === "ALREADY_ENDED") {
    const latest = await getTestSession(sessionId);
    return latest ?? updated;
  }
  return updated;
}

export interface EndTestLiveResult {
  session: LiveSession;
  /** True only when the session was BOTH ended AND fully deleted. A
   *  "keep" disposition always returns false here (nothing was meant to
   *  be deleted) — check `disposition` client-side for that case; this
   *  field specifically answers "was discard actually completed." */
  discarded: boolean;
  /** Set only when disposition was "discard" and cleanup failed after
   *  the session was already (successfully, atomically) ended — real
   *  business data was never at risk either way, but the UI must show
   *  this message instead of reporting a false "Discarded." */
  cleanupError?: string;
}

/** Ending is always attempted first and is essentially infallible (a
 *  guarded write, same shape as production's endLiveSession). Deletion
 *  is then a SEPARATE, distinguishable step for "discard" — if it fails,
 *  the ended session is left fully intact and visible in history for a
 *  retry via deleteTestSession(), which is itself idempotent/retry-safe.
 *  The caller must never report "Discarded" unless `discarded === true`. */
export async function endTestLiveSession(sessionId: string, disposition: "discard" | "keep"): Promise<EndTestLiveResult> {
  const session = await endTestSessionRecordOnly(sessionId);
  if (disposition === "keep") {
    return { session, discarded: false };
  }
  try {
    await deleteTestSession(sessionId);
    return { session, discarded: true };
  } catch {
    return {
      session,
      discarded: false,
      cleanupError: "Test session ended, but cleanup did not complete. Retry Delete Test Session.",
    };
  }
}

/** Hard-delete every key for one test session. Safe to retry — deleting
 *  keys that no longer exist is a no-op, which is exactly what makes
 *  "Retry Delete Test Session" after a failed discard just as safe as
 *  the first attempt. Refuses only while the session is still marked
 *  active (end it first) — a session already ended (by either
 *  disposition path) always passes this check. */
export async function deleteTestSession(sessionId: string): Promise<void> {
  const session = await getTestSession(sessionId);
  if (session && session.status === "active") {
    throw new Error("End this Test Live before deleting it.");
  }

  const [presentationIds, saleIds] = await Promise.all([
    redis.zrange(KEYS.presentationsBySession(sessionId), 0, -1) as Promise<string[]>,
    redis.zrange(KEYS.salesBySession(sessionId), 0, -1) as Promise<string[]>,
  ]);

  const keysToDelete = [
    KEYS.session(sessionId),
    KEYS.sessionState(sessionId),
    KEYS.presentationsBySession(sessionId),
    KEYS.salesBySession(sessionId),
    ...presentationIds.map((id) => KEYS.presentation(id)),
    ...saleIds.map((id) => KEYS.sale(id)),
  ];

  await redis.zrem(KEYS.sessionsIndex, sessionId);
  if (keysToDelete.length > 0) await redis.del(...keysToDelete);
}

// ---------------------------------------------------------------------
// Simulated inventory — real product data, simulated quantity
// ---------------------------------------------------------------------

/** The first time a product is touched (scanned/selected) in a test
 *  session, its REAL Product.inventory is read ONCE and copied into the
 *  session's own simulated-inventory map; every later touch in the same
 *  session reads/writes only that map, never a fresh real read. Returns
 *  a display product = the real product's fields with `inventory`
 *  overridden by the simulated value. */
export async function resolveSimulatedProduct(sessionId: string, productId: string): Promise<Product> {
  const product = await getProduct(productId);
  if (!product) throw new Error("Product not found.");

  const state = await getTestSessionState(sessionId);
  let entry = state.simulatedInventory[productId];
  if (!entry) {
    entry = { startingInventory: product.inventory, simulatedInventory: product.inventory };
    await redis.set(KEYS.sessionState(sessionId), {
      ...state,
      simulatedInventory: { ...state.simulatedInventory, [productId]: entry },
    });
  }
  return { ...product, inventory: entry.simulatedInventory };
}

// ---------------------------------------------------------------------
// Record Test Sale / Test No Sale / Cancel / Correct — each idempotent
// AND internally atomic (your correction #2): the simulated-inventory
// read-modify-write happens INSIDE the Lua script via cjson, never
// trusting a JS-computed "next state" the way patchTestSessionState
// does — there's no gap between "read the current count" and "write the
// decremented one" for two different concurrent requests to race inside,
// so no retry loop is needed the way production's MAX_CONFLICT_RETRIES
// is for real Record Sale.
// ---------------------------------------------------------------------

// KEYS[1] idempotency key
// KEYS[2] session_state key
// KEYS[3] sale key
// KEYS[4] presentation key
// KEYS[5] sales_by_session zset
// KEYS[6] presentations_by_session zset
// ARGV[1] idempotency marker (saleId, bare)
// ARGV[2] productId
// ARGV[3] quantity (string number)
// ARGV[4] new sale record (JSON)
// ARGV[5] new presentation (JSON)
// ARGV[6] score (timestamp ms)
// ARGV[7] saleId (zset member)
// ARGV[8] presentationId (zset member)
const RECORD_TEST_SALE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
local stateRaw = redis.call('GET', KEYS[2])
if not stateRaw then
  return 'NO_STATE'
end
local state = cjson.decode(stateRaw)
local entry = state.simulatedInventory[ARGV[2]]
if not entry then
  return 'NOT_INITIALIZED'
end
local qty = tonumber(ARGV[3])
if entry.simulatedInventory < qty then
  return 'INSUFFICIENT'
end
entry.simulatedInventory = entry.simulatedInventory - qty
state.simulatedInventory[ARGV[2]] = entry
redis.call('SET', KEYS[2], cjson.encode(state))
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[4], ARGV[5])
redis.call('ZADD', KEYS[5], ARGV[6], ARGV[7])
redis.call('ZADD', KEYS[6], ARGV[6], ARGV[8])
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

export interface RecordTestSaleInput {
  sessionId: string;
  productId: string;
  quantity: number;
  winningBid: number;
  operator: string;
  idempotencyKey: string;
}

export interface RecordTestSaleResult {
  saleId: string;
  presentationId: string;
}

export async function recordTestSale(input: RecordTestSaleInput): Promise<RecordTestSaleResult> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error("Quantity must be a positive whole number.");
  }
  if (!Number.isFinite(input.winningBid) || input.winningBid < 0) {
    throw new Error("Winning bid must be zero or greater.");
  }

  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) {
    const replayedSale = await getTestSaleById(fastReplay);
    if (replayedSale) return { saleId: replayedSale.id, presentationId: replayedSale.presentationId ?? "" };
  }

  // Ensure this product is initialized in the session's simulated map —
  // a no-op if it already is (e.g. re-scanned). This is the only real
  // read in this whole function; everything after is simulated.
  await resolveSimulatedProduct(input.sessionId, input.productId);
  const product = await getProduct(input.productId);
  if (!product) throw new Error("Product not found.");

  const saleId = newTestId("tsale");
  const presentationId = newTestId("tpres");
  const timestamp = new Date().toISOString();
  const operator = input.operator?.trim() || "Unknown";

  // Simulated cost, purely informational for the operator display —
  // read-only, never written back anywhere.
  const lots = await getLotsWithRemaining(input.productId);
  const simulatedLandedCost = computeWeightedAverageLandedCost(lots);

  const saleRecord: SaleRecord = {
    id: saleId,
    productId: input.productId,
    sku: product.sku,
    price: input.winningBid,
    quantity: input.quantity,
    soldAt: timestamp,
    status: "completed",
    lotId: null,
    landedCostAtSale: simulatedLandedCost,
    liveSessionId: input.sessionId,
    presentationId,
    saleVersion: 0,
    originalPrice: null,
    correctedAt: null,
    correctedBy: null,
    canceledAt: null,
    canceledBy: null,
  };
  const presentation: LivePresentation = {
    id: presentationId,
    liveSessionId: input.sessionId,
    productId: input.productId,
    sku: product.sku,
    outcome: "sold",
    quantity: input.quantity,
    saleId,
    timestamp,
    operator,
  };

  const keys = [
    idempotencyKeyOf(input.idempotencyKey),
    KEYS.sessionState(input.sessionId),
    KEYS.sale(saleId),
    KEYS.presentation(presentationId),
    KEYS.salesBySession(input.sessionId),
    KEYS.presentationsBySession(input.sessionId),
  ];
  const args = [
    saleId,
    input.productId,
    String(input.quantity),
    JSON.stringify(saleRecord),
    JSON.stringify(presentation),
    String(Date.now()),
    saleId,
    presentationId,
  ];

  const result = await redis.eval<(string | number)[], string>(RECORD_TEST_SALE_SCRIPT, keys, args);
  if (result === "INSUFFICIENT") {
    throw new Error(`Not enough simulated stock to sell ${input.quantity}.`);
  }
  if (result === "NOT_INITIALIZED" || result === "NO_STATE") {
    throw new Error("This product hasn't been loaded into the Test Live session yet.");
  }
  return { saleId, presentationId };
}

// KEYS[1] idempotency key, KEYS[2] presentation key, KEYS[3] presentations_by_session zset
// ARGV[1] marker (presentationId), ARGV[2] new presentation (JSON), ARGV[3] score, ARGV[4] presentationId
const NO_TEST_SALE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[4])
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

export interface RecordTestNoSaleInput {
  sessionId: string;
  productId: string;
  operator: string;
  idempotencyKey: string;
}

export async function recordTestNoSale(input: RecordTestNoSaleInput): Promise<{ presentationId: string }> {
  const fastReplay = await checkIdempotencyFast(input.idempotencyKey);
  if (fastReplay) return { presentationId: fastReplay };

  const product = await getProduct(input.productId);
  if (!product) throw new Error("Product not found.");

  const presentationId = newTestId("tpres");
  const presentation: LivePresentation = {
    id: presentationId,
    liveSessionId: input.sessionId,
    productId: input.productId,
    sku: product.sku,
    outcome: "no_sale",
    quantity: 0,
    saleId: null,
    timestamp: new Date().toISOString(),
    operator: input.operator?.trim() || "Unknown",
  };

  const keys = [idempotencyKeyOf(input.idempotencyKey), KEYS.presentation(presentationId), KEYS.presentationsBySession(input.sessionId)];
  const args = [presentationId, JSON.stringify(presentation), String(Date.now()), presentationId];
  const result = await redis.eval<(string | number)[], string>(NO_TEST_SALE_SCRIPT, keys, args);
  return { presentationId: result };
}

export async function getTestSaleById(saleId: string): Promise<SaleRecord | null> {
  return (await redis.get<SaleRecord>(KEYS.sale(saleId))) ?? null;
}

// KEYS[1] idempotency, KEYS[2] sale key, KEYS[3] session_state key
// ARGV[1] marker (saleId), ARGV[2] canceledAt, ARGV[3] canceledBy
const CANCEL_TEST_SALE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
local raw = redis.call('GET', KEYS[2])
if not raw then
  return 'NOT_FOUND'
end
local sale = cjson.decode(raw)
if sale.status == 'canceled' then
  return 'ALREADY_CANCELED'
end
sale.status = 'canceled'
sale.canceledAt = ARGV[2]
sale.canceledBy = ARGV[3]
redis.call('SET', KEYS[2], cjson.encode(sale))
local stateRaw = redis.call('GET', KEYS[3])
if stateRaw then
  local state = cjson.decode(stateRaw)
  local entry = state.simulatedInventory[sale.productId]
  if entry then
    entry.simulatedInventory = entry.simulatedInventory + sale.quantity
    state.simulatedInventory[sale.productId] = entry
    redis.call('SET', KEYS[3], cjson.encode(state))
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

export async function cancelTestSale(saleId: string, operator: string, idempotencyKey: string): Promise<SaleRecord> {
  const fastReplay = await checkIdempotencyFast(idempotencyKey);
  if (fastReplay) {
    const replayed = await getTestSaleById(saleId);
    if (replayed) return replayed;
  }

  const sale = await getTestSaleById(saleId);
  if (!sale) throw new Error("Test sale not found.");

  const keys = [idempotencyKeyOf(idempotencyKey), KEYS.sale(saleId), KEYS.sessionState(sale.liveSessionId ?? "")];
  const args = [saleId, new Date().toISOString(), operator?.trim() || "Unknown"];
  const result = await redis.eval<(string | number)[], string>(CANCEL_TEST_SALE_SCRIPT, keys, args);
  if (result === "NOT_FOUND") throw new Error("Test sale not found.");

  const latest = await getTestSaleById(saleId);
  if (!latest) throw new Error("Test sale not found after cancellation.");
  return latest;
}

// KEYS[1] idempotency, KEYS[2] sale key
// ARGV[1] marker (saleId), ARGV[2] new price, ARGV[3] correctedAt, ARGV[4] correctedBy
const CORRECT_TEST_SALE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
local raw = redis.call('GET', KEYS[2])
if not raw then
  return 'NOT_FOUND'
end
local sale = cjson.decode(raw)
if sale.status == 'canceled' then
  return 'CANCELED'
end
if sale.originalPrice == nil or sale.originalPrice == cjson.null then
  sale.originalPrice = sale.price
end
sale.price = tonumber(ARGV[2])
sale.correctedAt = ARGV[3]
sale.correctedBy = ARGV[4]
redis.call('SET', KEYS[2], cjson.encode(sale))
redis.call('SET', KEYS[1], ARGV[1], 'EX', 2592000)
return ARGV[1]
`;

export async function correctTestSalePrice(saleId: string, newPrice: number, operator: string, idempotencyKey: string): Promise<SaleRecord> {
  if (!Number.isFinite(newPrice) || newPrice < 0) {
    throw new Error("Corrected price must be zero or greater.");
  }
  const fastReplay = await checkIdempotencyFast(idempotencyKey);
  if (fastReplay) {
    const replayed = await getTestSaleById(saleId);
    if (replayed) return replayed;
  }

  const existing = await getTestSaleById(saleId);
  if (!existing) throw new Error("Test sale not found.");
  if (existing.status === "canceled") throw new Error("This test sale was canceled — it can't be corrected.");

  const keys = [idempotencyKeyOf(idempotencyKey), KEYS.sale(saleId)];
  const args = [saleId, String(newPrice), new Date().toISOString(), operator?.trim() || "Unknown"];
  const result = await redis.eval<(string | number)[], string>(CORRECT_TEST_SALE_SCRIPT, keys, args);
  if (result === "NOT_FOUND") throw new Error("Test sale not found.");
  if (result === "CANCELED") throw new Error("This test sale was canceled — it can't be corrected.");

  const latest = await getTestSaleById(saleId);
  if (!latest) throw new Error("Test sale not found after correction.");
  return latest;
}

// ---------------------------------------------------------------------
// Recent sales / presentations / stats for a session — same "derive
// live, never cache" shape as live-db.ts's equivalents, with a LOCAL
// copy of isEffectivelySold (see the top-of-file note on why).
// ---------------------------------------------------------------------

export interface TestSessionPresentationView {
  presentation: LivePresentation;
  sale: SaleRecord | null;
}

export async function getPresentationsForTestSession(sessionId: string, limit = 2000): Promise<TestSessionPresentationView[]> {
  const ids = (await redis.zrange(KEYS.presentationsBySession(sessionId), 0, limit - 1, { rev: true })) as string[];
  if (ids.length === 0) return [];
  const presentations = await Promise.all(ids.map((id) => redis.get<LivePresentation>(KEYS.presentation(id))));
  const views = await Promise.all(
    presentations.map(async (p) => {
      if (!p) return null;
      const sale = p.saleId ? await getTestSaleById(p.saleId) : null;
      return { presentation: p, sale } satisfies TestSessionPresentationView;
    })
  );
  return views.filter((v): v is TestSessionPresentationView => v !== null);
}

function isEffectivelySoldTest(view: TestSessionPresentationView): boolean {
  return view.presentation.outcome === "sold" && view.sale !== null && view.sale.status === "completed";
}

export async function getTestSessionStats(sessionId: string): Promise<LiveSessionStats> {
  const [session, views] = await Promise.all([getTestSession(sessionId), getPresentationsForTestSession(sessionId, 2000)]);
  if (!session) throw new Error("Test Live session not found.");

  const liveTimeMs =
    (session.endedAt ? new Date(session.endedAt).getTime() : Date.now()) - new Date(session.startedAt).getTime();
  const noSaleCount = views.filter((v) => v.presentation.outcome === "no_sale").length;
  const sold = views.filter(isEffectivelySoldTest);

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
// Operator-only financial display for the current product — Cost/
// Break-Even are read-only real data (safe); Last Sold/Avg Auction are
// computed from TEST sales only, so a rehearsal never shows real sales
// history as if it were part of the practice run.
// ---------------------------------------------------------------------

export interface TestProductFinancials {
  cost: number | null;
  costSource: "weighted_landed" | "legacy" | "unavailable";
  breakEven: BreakEvenResult;
  lastSoldPrice: number | null;
  averageAuction: number | null;
}

// Duplicated from live-db.ts's getSellingConfig/computeBreakEven (same
// shared config key, read-only) rather than imported — see the
// top-of-file note on why this file never imports live-db.ts.
const SELLING_CONFIG_KEY = "amoruh:live:selling_config";

async function getSharedSellingConfig(): Promise<SellingConfig> {
  return (await redis.get<SellingConfig>(SELLING_CONFIG_KEY)) ?? defaultSellingConfig();
}

function computeBreakEvenLocal(cost: number, config: SellingConfig): BreakEvenResult {
  if (config.platformFeePercent === null || config.paymentFeePercent === null) {
    return { status: "not_configured" };
  }
  const variableFeeRate = (config.platformFeePercent + config.paymentFeePercent) / 100;
  if (variableFeeRate >= 1) return { status: "not_configured" };
  const fixedSellingCosts = config.shippingSubsidy + config.packagingCost;
  return { status: "ok", breakEven: (cost + fixedSellingCosts) / (1 - variableFeeRate) };
}

export async function getTestProductFinancials(sessionId: string, productId: string, legacyCost: number): Promise<TestProductFinancials> {
  const lots = await getLotsWithRemaining(productId);
  const weighted = computeWeightedAverageLandedCost(lots);
  const cost = weighted ?? (legacyCost > 0 ? legacyCost : null);
  const costSource: TestProductFinancials["costSource"] =
    weighted !== null ? "weighted_landed" : legacyCost > 0 ? "legacy" : "unavailable";

  const sellingConfig = await getSharedSellingConfig();
  const breakEven: BreakEvenResult = cost !== null ? computeBreakEvenLocal(cost, sellingConfig) : { status: "not_configured" };

  const views = await getPresentationsForTestSession(sessionId, 2000);
  const productSales = views
    .filter((v) => v.presentation.productId === productId && isEffectivelySoldTest(v))
    .map((v) => v.sale!)
    .sort((a, b) => b.soldAt.localeCompare(a.soldAt));

  const lastSoldPrice = productSales[0]?.price ?? null;
  const averageAuction = productSales.length > 0 ? productSales.reduce((s, r) => s + r.price, 0) / productSales.length : null;

  return { cost, costSource, breakEven, lastSoldPrice, averageAuction };
}
