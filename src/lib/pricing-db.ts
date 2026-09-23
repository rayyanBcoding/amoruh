import { redis } from "./kv";
import type {
  LeaderboardData,
  LeaderboardOfferRow,
  LeaderboardProductEntry,
  LeaderboardSingleSupplierEntry,
  LeaderboardTotals,
  MatchReviewBucket,
  MatchReviewItem,
  MatchReviewSummary,
  OfferComparisonRow,
  PricingReferenceProduct,
  ProductOfferComparison,
  ReferenceProductOfferComparison,
  ReviewStatus,
  SupplierAlias,
  SupplierOfferCurrent,
  SupplierOfferSnapshot,
  SupplierLeaderboardSummary,
  SupplierPriceUpload,
  UploadStatus,
} from "./pricing-types";
import { getSuppliers } from "./intake-db";
import { getUsdRate, convertToUsd } from "./pricing-fx";
import {
  BARCODE_CONFLICT_TEXT_FLOOR,
  buildSearchTokens,
  extractAttributes,
  extractProductAttributes,
  extractReferenceProductAttributes,
  isPlausibleBarcode,
  isValidProductRow,
  matchAgainstMasterCandidates,
  quickTextSimilarity,
  resolveEffectiveBrand,
  type MasterCandidate,
} from "./pricing-matching";
import { bigramSimilarity, normalize } from "./intake-matching";
import { getProducts } from "./db";

// ---------------------------------------------------------------------
// Pricing / Ordering — storage layer.
//
// PUBLICATION MODEL (the redesign from plan review): a supplier's
// "current" pricing is never edited in place. It lives in one Redis
// Hash per GENERATION (amoruh:pricing:offer_current:{supplierId}:
// {generationId}) built entirely during STAGING — batched writes are
// fine here because the candidate hash is inert; nothing reads it by
// this key until it's referenced. Publishing a generation is a single
// small, genuinely atomic Lua script (COMMIT_SCRIPT below) that does
// nothing but: (1) check a monotonically-increasing per-supplier
// sequence number so a late-finishing OLDER upload can never overwrite
// a newer one's already-committed result, and (2) flip one pointer key
// plus a few small, bounded index writes (only the offers/aliases this
// upload actually changed). It never touches the big hash itself — that
// was already fully built before commit runs. A pipeline is NOT used
// for anything that needs to be all-or-nothing; only this one small
// script is.
// ---------------------------------------------------------------------

const KEYS = {
  uploadSeq: (supplierId: string) => `amoruh:pricing:upload_seq:${supplierId}`,
  currentGenerationId: (supplierId: string) => `amoruh:pricing:current_generation_id:${supplierId}`,
  currentGenerationSeq: (supplierId: string) => `amoruh:pricing:current_generation_seq:${supplierId}`,
  offerCurrentHash: (supplierId: string, generationId: string) =>
    `amoruh:pricing:offer_current:${supplierId}:${generationId}`,
  upload: (uploadId: string) => `amoruh:pricing:upload:${uploadId}`,
  uploadsBySupplier: (supplierId: string) => `amoruh:pricing:uploads_by_supplier:${supplierId}`,
  uploadsAll: "amoruh:pricing:uploads_all",
  offerSnapshot: (uploadId: string, rowIndex: number) => `amoruh:pricing:offer_snapshot:${uploadId}:${rowIndex}`,
  offerHistory: (supplierId: string, offerKey: string) => `amoruh:pricing:offer_history:${supplierId}:${offerKey}`,
  aliases: (supplierId: string) => `amoruh:pricing:aliases:${supplierId}`,
  offersByProduct: (productId: string) => `amoruh:pricing:offers_by_product:${productId}`,
  referenceProduct: (id: string) => `amoruh:pricing:reference_product:${id}`,
  referenceProductsIndex: "amoruh:pricing:reference_products_index",
  // Normalized (trimmed + uppercased) at this single choke point so every
  // caller's pointer read/write agrees regardless of the case IT happens
  // to pass — real barcodes here are numeric-only (uppercasing is a
  // no-op), but callers that build these keys are otherwise inconsistent
  // about case (matchSupplierRow's own in-memory barcode comparisons
  // already uppercase both sides; the pointer-key callers didn't, until
  // now) — confirmed directly via a real cross-file mismatch during
  // Phase 1 verification (intake-product-linking.ts's own lookup
  // uppercases before calling these).
  referenceProductByUpc: (upc: string) => `amoruh:pricing:reference_product_by_upc:${upc.trim().toUpperCase()}`,
  referenceProductByEan: (ean: string) => `amoruh:pricing:reference_product_by_ean:${ean.trim().toUpperCase()}`,
  /** Global Master Product identity signature pointer — see
   *  computeIdentitySignature (pricing-matching.ts). The fallback exact-
   *  match check for auto-creation dedup when a row has no UPC/EAN. */
  referenceProductBySignature: (signature: string) => `amoruh:pricing:reference_product_by_signature:${signature}`,
  /** Mirrors offersByProduct exactly, for Master/Reference Products —
   *  the reverse index a search/comparison view needs to answer "every
   *  supplier offer for this Master Product," same as offersByProduct
   *  already does for real Products. */
  offersByReferenceProduct: (referenceProductId: string) => `amoruh:pricing:offers_by_reference_product:${referenceProductId}`,
  /** Reference-product search index (searchReferenceProducts): one SET
   *  per token -> member reference-product ids, plus one sorted set of
   *  every distinct token (score 0, pure lexicographic ordering) used
   *  for ZRANGEBYLEX prefix lookups so a partially-typed word ("burber")
   *  still finds "burberry" before the word is finished. Rebuildable in
   *  full from getAllReferenceProducts() — see scripts/rebuild-search-index.ts. */
  searchToken: (token: string) => `amoruh:pricing:search:token:${token}`,
  searchTokenIndex: "amoruh:pricing:search:token_index",
  /** Supplier price leaderboard cache — see computeSupplierPriceLeaderboard. */
  leaderboard: "amoruh:pricing:leaderboard:v1",
  leaderboardMeta: "amoruh:pricing:leaderboard:meta",
  /** Monotonic counter bumped by every write path that changes offer/
   *  Master-Product eligibility WITHOUT going through commitGeneration
   *  (relinking, unlinking, manual resolution, reference-product
   *  creation) — the second of the two signals the leaderboard cache
   *  verifies before trusting itself as current. */
  catalogVersion: "amoruh:pricing:catalog_version",
} as const;

export function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------

/** Assigns `seq` in START order (not completion order) — this is what
 *  makes the commit-time ordering guard correct: a later-STARTED upload
 *  always has a higher seq, regardless of which finishes staging first. */
export async function createUpload(input: {
  supplierId: string;
  filename: string;
  blobUrl: string;
  uploadType: "full" | "partial";
  totalRows: number;
}): Promise<SupplierPriceUpload> {
  const seq = await redis.incr(KEYS.uploadSeq(input.supplierId));
  const id = newId("upl");
  const upload: SupplierPriceUpload = {
    id,
    supplierId: input.supplierId,
    filename: input.filename,
    blobUrl: input.blobUrl,
    uploadType: input.uploadType,
    status: "processing",
    seq,
    totalRows: input.totalRows,
    processedRows: 0,
    autoMatched: 0,
    autoCreated: 0,
    needsReview: 0,
    newCandidates: 0,
    notAProduct: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };
  const now = Date.now();
  await Promise.all([
    redis.set(KEYS.upload(id), upload),
    redis.zadd(KEYS.uploadsBySupplier(input.supplierId), { score: now, member: id }),
    redis.zadd(KEYS.uploadsAll, { score: now, member: id }),
  ]);
  return upload;
}

export async function getUpload(uploadId: string): Promise<SupplierPriceUpload | null> {
  return (await redis.get<SupplierPriceUpload>(KEYS.upload(uploadId))) ?? null;
}

/** Progress/error updates during staging — plain read-modify-write.
 *  Never the authority on whether a generation is live (that's the
 *  seq-guarded commit script) — this just keeps the upload record
 *  visibly accurate while staging runs, so a stuck upload is visibly
 *  partial rather than invisible. */
export async function updateUploadProgress(uploadId: string, patch: Partial<SupplierPriceUpload>): Promise<void> {
  const current = await getUpload(uploadId);
  if (!current) return;
  await redis.set(KEYS.upload(uploadId), { ...current, ...patch });
}

export async function markUploadFailed(uploadId: string, error: string): Promise<void> {
  await updateUploadProgress(uploadId, { status: "failed" as UploadStatus, error, completedAt: new Date().toISOString() });
}

export async function getUploadsForSupplier(supplierId: string, limit = 20): Promise<SupplierPriceUpload[]> {
  const ids = (await redis.zrange(KEYS.uploadsBySupplier(supplierId), 0, limit - 1, { rev: true })) as string[];
  const uploads = await Promise.all(ids.map(getUpload));
  return uploads.filter((u): u is SupplierPriceUpload => u !== null);
}

export async function getRecentUploads(limit = 20): Promise<SupplierPriceUpload[]> {
  const ids = (await redis.zrange(KEYS.uploadsAll, 0, limit - 1, { rev: true })) as string[];
  const uploads = await Promise.all(ids.map(getUpload));
  return uploads.filter((u): u is SupplierPriceUpload => u !== null);
}

// ---------------------------------------------------------------------
// Immutable history (snapshots) — deterministic keys, safe to retry.
// ---------------------------------------------------------------------

// Kept sequential across chunks, unlike writeCandidateGeneration above —
// tried firing every chunk's ~400 ops (thousands of concurrent commands
// for a large upload) at once, and separately tried a small bounded
// concurrency window; both measured WORSE than plain sequential chunks
// in isolated testing (a large simultaneous burst appears to be
// counterproductive here, whether from client connection limits or
// Redis-side throttling). Each chunk's own 400 ops are still
// parallelized via Promise.all — only the chunks themselves run one at
// a time, exactly as before this investigation.
export async function writeSnapshotsBatch(snapshots: SupplierOfferSnapshot[]): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < snapshots.length; i += CHUNK) {
    const chunk = snapshots.slice(i, i + CHUNK);
    await Promise.all([
      ...chunk.map((s) => redis.set(KEYS.offerSnapshot(s.uploadId, s.rowIndex), s)),
      ...chunk.map((s) =>
        redis.zadd(KEYS.offerHistory(s.supplierId, s.offerKey), {
          score: new Date(s.uploadedAt).getTime(),
          member: `${s.uploadId}:${s.rowIndex}`,
        })
      ),
    ]);
  }
}

export async function getOfferHistory(supplierId: string, offerKey: string, limit = 50): Promise<SupplierOfferSnapshot[]> {
  const members = (await redis.zrange(KEYS.offerHistory(supplierId, offerKey), 0, limit - 1, { rev: true })) as string[];
  const snapshots = await Promise.all(
    members.map((m) => {
      const [uploadId, rowIndexStr] = m.split(":");
      return redis.get<SupplierOfferSnapshot>(KEYS.offerSnapshot(uploadId, Number(rowIndexStr)));
    })
  );
  return snapshots.filter((s): s is SupplierOfferSnapshot => s !== null);
}

// ---------------------------------------------------------------------
// Generation staging — safe to fail; nothing here is visible to readers
// until the commit script flips the pointer.
// ---------------------------------------------------------------------

export async function getCurrentGenerationId(supplierId: string): Promise<string | null> {
  return (await redis.get<string>(KEYS.currentGenerationId(supplierId))) ?? null;
}

export async function getCurrentGenerationSeq(supplierId: string): Promise<number> {
  return (await redis.get<number>(KEYS.currentGenerationSeq(supplierId))) ?? 0;
}

/** The previously-committed generation's full offer map, or {} if this
 *  supplier has never had a committed upload — the copy-forward base for
 *  a new candidate generation. */
export async function getCommittedOffers(supplierId: string): Promise<Record<string, SupplierOfferCurrent>> {
  const generationId = await getCurrentGenerationId(supplierId);
  if (!generationId) return {};
  return (await redis.hgetall<Record<string, SupplierOfferCurrent>>(KEYS.offerCurrentHash(supplierId, generationId))) ?? {};
}

/** Writes the fully-computed candidate generation content in bounded
 *  batches. Safe to fail partway — this key is inert until a commit
 *  script points to it, so a partial write here just means a wasted,
 *  never-referenced generation id if the upload later fails.
 *
 *  Batches are issued in parallel, not awaited one at a time — confirmed
 *  a real, severe cost at Jizan's scale (6,352 offers): 32 sequential
 *  HSET round trips measured ~25.7s on their own, independently enough
 *  to threaten Vercel's 60s timeout even with every other fix in place.
 *  Safe to parallelize: each chunk writes a disjoint set of hash fields
 *  on the SAME key (Object.entries sliced without overlap), so there is
 *  no write-write race between chunks. */
export async function writeCandidateGeneration(
  supplierId: string,
  generationId: string,
  offers: Record<string, SupplierOfferCurrent>
): Promise<void> {
  const key = KEYS.offerCurrentHash(supplierId, generationId);
  const entries = Object.entries(offers);
  const CHUNK = 200;
  const writes: Promise<number>[] = [];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = Object.fromEntries(entries.slice(i, i + CHUNK));
    if (Object.keys(chunk).length > 0) writes.push(redis.hset(key, chunk));
  }
  await Promise.all(writes);
}

// ---------------------------------------------------------------------
// COMMIT — the one genuinely atomic step. Fixed keys 1-4, then a
// variable, bounded run of offers_by_product SADD/SREM ops (only for
// offers newly linked/unlinked THIS upload) — same "small fixed core +
// bounded variable loop" shape as atomic-write.ts's generic script,
// gated by a compare-and-swap exactly like sales-analytics.ts's Mark
// Sold script.
// ---------------------------------------------------------------------

const COMMIT_SCRIPT = `
local seqNow = tonumber(redis.call('GET', KEYS[2]) or '0')
local incoming = tonumber(ARGV[1])
if incoming <= seqNow then
  return 'STALE_GENERATION'
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('SET', KEYS[3], ARGV[3])
redis.call('SET', KEYS[4], ARGV[4])
local argIdx = 5
for i = 5, #KEYS do
  local op = ARGV[argIdx]
  local member = ARGV[argIdx + 1]
  if op == 'SADD' then
    redis.call('SADD', KEYS[i], member)
  elseif op == 'SREM' then
    redis.call('SREM', KEYS[i], member)
  end
  argIdx = argIdx + 2
end
return 'OK'
`;

export interface OffersByProductOp {
  op: "SADD" | "SREM";
  productId: string;
  member: string; // `${supplierId}::${offerKey}`
}

/** Mirrors OffersByProductOp exactly, for the Master/Reference Product
 *  reverse index. The commit/resolve scripts below are already fully
 *  generic over "any SADD/SREM pair from KEYS[5..]/KEYS[3..] onward" —
 *  this reuses that same mechanism rather than a second script. */
export interface OffersByReferenceProductOp {
  op: "SADD" | "SREM";
  referenceProductId: string;
  member: string;
}

export async function commitGeneration(input: {
  supplierId: string;
  uploadId: string;
  seq: number;
  generationId: string;
  finishedUpload: SupplierPriceUpload;
  newAliases: SupplierAlias[];
  offersByProductOps: OffersByProductOp[];
  offersByReferenceProductOps?: OffersByReferenceProductOp[];
}): Promise<"OK" | "STALE_GENERATION"> {
  const refOps = input.offersByReferenceProductOps ?? [];
  const keys = [
    KEYS.currentGenerationId(input.supplierId),
    KEYS.currentGenerationSeq(input.supplierId),
    KEYS.upload(input.uploadId),
    KEYS.aliases(input.supplierId),
    ...input.offersByProductOps.map((o) => KEYS.offersByProduct(o.productId)),
    ...refOps.map((o) => KEYS.offersByReferenceProduct(o.referenceProductId)),
  ];
  const args = [
    String(input.seq),
    input.generationId,
    JSON.stringify(input.finishedUpload),
    JSON.stringify(input.newAliases),
    ...input.offersByProductOps.flatMap((o) => [o.op, o.member]),
    ...refOps.flatMap((o) => [o.op, o.member]),
  ];
  const result = await redis.eval<(string | number)[], "OK" | "STALE_GENERATION">(COMMIT_SCRIPT, keys, args);
  // Belt-and-suspenders: the leaderboard's generationFingerprint check
  // already catches this on its own (this supplier's seq just changed),
  // but bumping the shared counter too keeps a single, uniform
  // "something changed" signal across every write path.
  if (result === "OK") await bumpCatalogVersion();
  return result;
}

// ---------------------------------------------------------------------
// Manual Match Review actions — a single targeted offer change outside
// of an upload. Simpler than a bulk publish (no seq guard needed — this
// isn't racing another upload's generation), but still one small atomic
// script so "linked the offer" and "wrote the alias" can't split apart.
// ---------------------------------------------------------------------

const RESOLVE_OFFER_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
local argIdx = 4
for i = 3, #KEYS do
  local op = ARGV[argIdx]
  local member = ARGV[argIdx + 1]
  if op == 'SADD' then
    redis.call('SADD', KEYS[i], member)
  elseif op == 'SREM' then
    redis.call('SREM', KEYS[i], member)
  end
  argIdx = argIdx + 2
end
return 'OK'
`;

export async function resolveOfferManually(input: {
  supplierId: string;
  offerKey: string;
  updatedOffer: SupplierOfferCurrent;
  newAliases: SupplierAlias[];
  offersByProductOps: OffersByProductOp[];
  offersByReferenceProductOps?: OffersByReferenceProductOp[];
}): Promise<void> {
  const generationId = await getCurrentGenerationId(input.supplierId);
  if (!generationId) throw new Error("This supplier has no committed price list to update yet.");

  const refOps = input.offersByReferenceProductOps ?? [];
  const keys = [
    KEYS.offerCurrentHash(input.supplierId, generationId),
    KEYS.aliases(input.supplierId),
    ...input.offersByProductOps.map((o) => KEYS.offersByProduct(o.productId)),
    ...refOps.map((o) => KEYS.offersByReferenceProduct(o.referenceProductId)),
  ];
  const args = [
    input.offerKey,
    JSON.stringify(input.updatedOffer),
    JSON.stringify(input.newAliases),
    ...input.offersByProductOps.flatMap((o) => [o.op, o.member]),
    ...refOps.flatMap((o) => [o.op, o.member]),
  ];
  await redis.eval<(string | number)[], string>(RESOLVE_OFFER_SCRIPT, keys, args);
  await bumpCatalogVersion();
}

/** One-time BULK primitive for a large reclassification sweep (e.g. the
 *  backlog migration) — the same field-level write resolveOfferManually
 *  does per offer, chunked for throughput instead of one Redis round
 *  trip per row. NOT used by any live request path; only by an
 *  explicit, reviewed migration script. Deliberately does not touch
 *  aliases (a bulk reclassification isn't the same kind of operator-
 *  confirmed evidence an upload/Match Review action is) and does not
 *  redo the commit script's seq-guard — it writes directly into
 *  whatever generation is CURRENT for this supplier at call time, safe
 *  as long as no concurrent upload for the SAME supplier commits a new
 *  generation mid-sweep (run one-time migrations during a quiet
 *  window). */
export async function bulkUpdateOffers(
  supplierId: string,
  updates: Record<string, SupplierOfferCurrent>,
  ops: { offersByProductOps?: OffersByProductOp[]; offersByReferenceProductOps?: OffersByReferenceProductOp[] } = {}
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
  const generationId = await getCurrentGenerationId(supplierId);
  if (!generationId) return { ok: false, reason: "This supplier has no committed price list." };

  const key = KEYS.offerCurrentHash(supplierId, generationId);
  const entries = Object.entries(updates);
  const CHUNK = 200;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = Object.fromEntries(entries.slice(i, i + CHUNK));
    if (Object.keys(chunk).length > 0) await redis.hset(key, chunk);
  }

  for (const op of ops.offersByProductOps ?? []) {
    if (op.op === "SADD") await redis.sadd(KEYS.offersByProduct(op.productId), op.member);
    else await redis.srem(KEYS.offersByProduct(op.productId), op.member);
  }
  for (const op of ops.offersByReferenceProductOps ?? []) {
    if (op.op === "SADD") await redis.sadd(KEYS.offersByReferenceProduct(op.referenceProductId), op.member);
    else await redis.srem(KEYS.offersByReferenceProduct(op.referenceProductId), op.member);
  }

  return { ok: true, count: entries.length };
}

// ---------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------

export async function getAliasesForSupplier(supplierId: string): Promise<SupplierAlias[]> {
  return (await redis.get<SupplierAlias[]>(KEYS.aliases(supplierId))) ?? [];
}

// ---------------------------------------------------------------------
// Reference products — Pricing/Ordering's OWN tracked items, never the
// real Product catalog. Keyed/indexed, not a flat array: supplier
// PROFILES are a handful of records (a flat array is fine there), but
// this collection can realistically reach the thousands — a whole
// supplier catalog's worth — so every write touches only its own record
// key + a small, bounded set of index entries, never a shared blob that
// has to be read-and-rewritten whole on every create. Same
// "one-key-per-record + zset index" shape already proven out for Live
// sessions and Pricing generations, and the exact scaling mistake
// (`KEYS` over a pattern that grows with row count) already fixed once
// in this codebase for offer snapshots is avoided the same way here:
// every read below is a bounded ZRANGE or a direct key GET, never KEYS.
// ---------------------------------------------------------------------

export async function getReferenceProduct(id: string): Promise<PricingReferenceProduct | null> {
  return (await redis.get<PricingReferenceProduct>(KEYS.referenceProduct(id))) ?? null;
}

export async function getReferenceProductByUpc(upc: string): Promise<PricingReferenceProduct | null> {
  if (!upc) return null;
  const id = await redis.get<string>(KEYS.referenceProductByUpc(upc));
  return id ? getReferenceProduct(id) : null;
}

export async function getReferenceProductByEan(ean: string): Promise<PricingReferenceProduct | null> {
  if (!ean) return null;
  const id = await redis.get<string>(KEYS.referenceProductByEan(ean));
  return id ? getReferenceProduct(id) : null;
}

/** Deletes exactly one Master/Reference Product and its UPC/EAN/
 *  signature pointer keys + index membership — the write-side
 *  counterpart to recovery-diff.ts's read-only identification, for
 *  targeted, selective restore (e.g. undoing a specific migration run's
 *  own creations). Never called from any live request path.
 *
 *  Safety: before touching a pointer key, re-reads it and confirms it
 *  STILL points at this exact id. A pointer that's since been repointed
 *  to a different (legitimately newer) record is left completely
 *  untouched — this is what stops a restore from ever damaging
 *  unrelated activity that happened after the record being removed was
 *  created. Returns which parts were actually deleted vs. skipped, so
 *  the caller can report precisely what happened rather than assume. */
export async function deleteReferenceProductAndPointers(
  id: string,
  signature: string
): Promise<{ deletedRecord: boolean; deletedUpcPointer: boolean; deletedEanPointer: boolean; deletedSignaturePointer: boolean; deletedFromIndex: boolean }> {
  const record = await getReferenceProduct(id);
  if (!record) {
    return { deletedRecord: false, deletedUpcPointer: false, deletedEanPointer: false, deletedSignaturePointer: false, deletedFromIndex: false };
  }

  const [upcOwner, eanOwner, sigOwner] = await Promise.all([
    record.upc ? redis.get<string>(KEYS.referenceProductByUpc(record.upc)) : Promise.resolve(null),
    record.ean ? redis.get<string>(KEYS.referenceProductByEan(record.ean)) : Promise.resolve(null),
    redis.get<string>(KEYS.referenceProductBySignature(signature)),
  ]);

  const ops: Promise<unknown>[] = [redis.del(KEYS.referenceProduct(id)), redis.zrem(KEYS.referenceProductsIndex, id)];
  if (record.upc && upcOwner === id) ops.push(redis.del(KEYS.referenceProductByUpc(record.upc)));
  if (record.ean && eanOwner === id) ops.push(redis.del(KEYS.referenceProductByEan(record.ean)));
  if (sigOwner === id) ops.push(redis.del(KEYS.referenceProductBySignature(signature)));
  await Promise.all(ops);

  return {
    deletedRecord: true,
    deletedUpcPointer: Boolean(record.upc) && upcOwner === id,
    deletedEanPointer: Boolean(record.ean) && eanOwner === id,
    deletedSignaturePointer: sigOwner === id,
    deletedFromIndex: true,
  };
}

export async function createReferenceProduct(
  input: Omit<PricingReferenceProduct, "id" | "createdAt">
): Promise<PricingReferenceProduct> {
  const product: PricingReferenceProduct = {
    ...input,
    id: newId("refprod"),
    createdAt: new Date().toISOString(),
  };
  await Promise.all([
    redis.set(KEYS.referenceProduct(product.id), product),
    redis.zadd(KEYS.referenceProductsIndex, { score: Date.now(), member: product.id }),
    product.upc ? redis.set(KEYS.referenceProductByUpc(product.upc), product.id) : Promise.resolve(),
    product.ean ? redis.set(KEYS.referenceProductByEan(product.ean), product.id) : Promise.resolve(),
    indexReferenceProductForSearch(product),
  ]);
  await bumpCatalogVersion();
  return product;
}

/** Sets productId on an existing Master Product — the ONLY way this link
 *  is ever made, from Intake's own receiving-time integration hook (plan
 *  §6, intake-product-linking.ts), once something is actually stocked.
 *  A plain read-modify-write is safe here: productId has no reverse-
 *  index consequences of its own (offers_by_reference_product stays
 *  keyed by the Master Product's own id regardless), and this never
 *  silently reassigns an EXISTING different link — that would be
 *  exactly the kind of guess §6 forbids, so it's refused instead. */
export async function linkReferenceProductToProduct(
  referenceProductId: string,
  productId: string
): Promise<
  | { ok: true; referenceProduct: PricingReferenceProduct }
  | { ok: false; reason: "not_found" | "already_linked_elsewhere" }
> {
  const existing = await getReferenceProduct(referenceProductId);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.productId && existing.productId !== productId) {
    return { ok: false, reason: "already_linked_elsewhere" };
  }
  if (existing.productId === productId) return { ok: true, referenceProduct: existing };
  const updated: PricingReferenceProduct = { ...existing, productId };
  await redis.set(KEYS.referenceProduct(referenceProductId), updated);
  await bumpCatalogVersion();
  return { ok: true, referenceProduct: updated };
}

/** Newest-first page of the index — bounded, never a full-collection
 *  read. */
export async function getReferenceProducts(params: { limit?: number; cursor?: number } = {}): Promise<{
  items: PricingReferenceProduct[];
  nextCursor: number | null;
}> {
  const limit = params.limit ?? 50;
  const cursor = params.cursor ?? 0;
  const ids = (await redis.zrange(KEYS.referenceProductsIndex, cursor, cursor + limit - 1, { rev: true })) as string[];
  const items = (await Promise.all(ids.map(getReferenceProduct))).filter((p): p is PricingReferenceProduct => p !== null);
  const nextCursor = ids.length === limit ? cursor + limit : null;
  return { items, nextCursor };
}

/** Adds/refreshes one reference product's membership in the search
 *  token index (per-token id SETs + the lexicographic token_index for
 *  prefix lookups). Called after every reference-product creation.
 *  Fire-and-forget-safe and idempotent (SADD/ZADD) — if it ever fails or
 *  drifts, scripts/rebuild-search-index.ts rebuilds the whole index from
 *  getAllReferenceProducts() from scratch. Deliberately NOT part of the
 *  atomic get-or-create Lua script (GET_OR_CREATE_REFERENCE_PRODUCT_SCRIPT)
 *  — same accepted pattern as backfillOfferByReferenceProduct's own
 *  "predates/self-heals the index" doc comment. */
export async function indexReferenceProductForSearch(product: PricingReferenceProduct): Promise<void> {
  const tokens = buildSearchTokens(`${product.brand} ${product.name} ${product.description}`);
  if (tokens.length === 0) return;
  const [first, ...rest] = tokens.map((t) => ({ score: 0, member: t }));
  await Promise.all([...tokens.map((t) => redis.sadd(KEYS.searchToken(t), product.id)), redis.zadd(KEYS.searchTokenIndex, first, ...rest)]);
}

const PREFIX_TOKEN_LIMIT = 50;
const REFERENCE_SEARCH_EXACT_SCORE = 2; // above any possible fuzzy score (max 1) -- always ranks first
// Applied ONLY to the looser union fallback below -- candidates found via
// the primary token/prefix INTERSECTION are already precise by
// construction (every query word is a real, indexed word of that
// record, or a genuine prefix of one), so gating them by a generic fuzzy
// score would do exactly what broke "burber" -> Burberry: a short
// prefix scores low against a long multi-word record even though the
// match itself is exact and correct. The score is still computed for
// ranking (best match first), just never used to exclude a primary hit.
const REFERENCE_SEARCH_FALLBACK_MIN_SCORE = 0.35;

async function idsForToken(token: string): Promise<string[]> {
  return redis.smembers(KEYS.searchToken(token)) as Promise<string[]>;
}

/** Every id whose record has TOKEN as an exact word, or has some word
 *  starting with TOKEN (prefix expansion via the lexicographic index) —
 *  used for the last, possibly-still-being-typed query word. */
async function idsForTokenOrPrefix(token: string): Promise<Set<string>> {
  const prefixTokens = await redis.zrange<string[]>(KEYS.searchTokenIndex, `[${token}`, `[${token}\xff`, { byLex: true, offset: 0, count: PREFIX_TOKEN_LIMIT });
  const idSets = await Promise.all(prefixTokens.map(idsForToken));
  const ids = new Set<string>();
  for (const set of idSets) for (const id of set) ids.add(id);
  return ids;
}

function intersect(sets: Set<string>[]): Set<string> {
  if (sets.length === 0) return new Set();
  let result = sets[0];
  for (const s of sets.slice(1)) result = new Set([...result].filter((id) => s.has(id)));
  return result;
}

/** Exact UPC/EAN hit first (O(1)); otherwise an indexed lookup —
 *  intersecting exact-token candidates for every complete query word,
 *  and prefix-expanding (ZRANGEBYLEX) only the LAST word so a
 *  partially-typed word ("burber") still finds "burberry" — instead of
 *  a full-catalog substring scan. If that precise intersection comes up
 *  empty (e.g. a typo on a non-last word), falls back to a looser union
 *  of every query word's candidates, scored and floored so that looser
 *  path doesn't surface unrelated results. MGETs only the small
 *  candidate set found this way — never the full catalog. */
export async function searchReferenceProducts(query: string, limit = 20): Promise<PricingReferenceProduct[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const [byUpc, byEan] = await Promise.all([getReferenceProductByUpc(trimmed), getReferenceProductByEan(trimmed)]);
  if (byUpc) return [byUpc];
  if (byEan) return [byEan];

  const queryTokens = buildSearchTokens(trimmed);
  if (queryTokens.length === 0) return [];

  const completeTokens = queryTokens.slice(0, -1);
  const lastToken = queryTokens[queryTokens.length - 1];

  const [exactSets, lastTokenCandidates] = await Promise.all([
    Promise.all(completeTokens.map(idsForToken)).then((sets) => sets.map((s) => new Set(s))),
    idsForTokenOrPrefix(lastToken),
  ]);

  let candidateIds = intersect([...exactSets, lastTokenCandidates]);
  let fallback = false;
  if (candidateIds.size === 0) {
    // Loose fallback: union of every token's own candidates (each still
    // index-bounded, never a full scan), scored+floored since this path
    // is deliberately less precise than the primary intersection.
    fallback = true;
    const allSets = await Promise.all([...completeTokens, lastToken].map((t) => idsForTokenOrPrefix(t)));
    candidateIds = new Set<string>();
    for (const s of allSets) for (const id of s) candidateIds.add(id);
  }
  if (candidateIds.size === 0) return [];

  const records = (await Promise.all([...candidateIds].map(getReferenceProduct))).filter((r): r is PricingReferenceProduct => r !== null);
  const qNormalized = normalize(trimmed);

  const scored = records
    .map((r) => {
      const nameNormalized = normalize(`${r.brand} ${r.name}`);
      const exact = nameNormalized === qNormalized;
      const score = exact ? REFERENCE_SEARCH_EXACT_SCORE : quickTextSimilarity(trimmed, `${r.brand} ${r.name} ${r.description}`);
      return { record: r, score };
    })
    .filter((s) => !fallback || s.score >= REFERENCE_SEARCH_FALLBACK_MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.record);
}

/** Fetches the ENTIRE reference-product catalog — the matching pool a
 *  supplier upload's row loop needs (pricing-process.ts) and the pool
 *  buildMasterCandidatePool dedupes against linked real Products. Same
 *  bounded-page-to-exhaustion shape as searchReferenceProducts's full
 *  scan, just collecting every record instead of filtering by text. This
 *  is called at the start of every parse-preview and every process call
 *  — confirmed a real, measurably variable cost (2-20s) once the catalog
 *  grew past the "hundreds to low thousands" this originally assumed:
 *  fetching each page via `Promise.all(ids.map(getReferenceProduct))`
 *  issues one separate GET round trip per key. MGET fetches an entire
 *  page's values in a single Redis command instead. */
export async function getAllReferenceProducts(): Promise<PricingReferenceProduct[]> {
  const PAGE = 1000;
  const all: PricingReferenceProduct[] = [];
  let cursor = 0;
  for (;;) {
    const ids = (await redis.zrange(KEYS.referenceProductsIndex, cursor, cursor + PAGE - 1)) as string[];
    if (ids.length === 0) break;
    const records = await redis.mget<(PricingReferenceProduct | null)[]>(ids.map((id) => KEYS.referenceProduct(id)));
    for (const r of records) if (r) all.push(r);
    if (ids.length < PAGE) break;
    cursor += PAGE;
  }
  return all;
}

// ---------------------------------------------------------------------
// Idempotent get-or-create for auto-created Master Products — plan §5b.
// A small atomic script over a FIXED set of pointer keys, same shape as
// RESOLVE_OFFER_SCRIPT/COMMIT_SCRIPT above, not a new paradigm. Checks
// the UPC pointer, EAN pointer, and the structural identity-signature
// pointer (computeIdentitySignature, pricing-matching.ts) together:
//
//  - all pointers that resolve agree on one id (or only one resolves at
//    all) → EXISTING — the caller must treat the record as-is and never
//    write to its provenance fields (creationMethod/createdFrom*/
//    createdAt); this is what makes a retried upload, an independently
//    re-uploaded file, or a second supplier's row for the same physical
//    item all resolve to the SAME Master Product instead of duplicating
//    it, without ever silently overwriting who/why it was first created.
//  - pointers resolve to DIFFERENT existing records → CONFLICT, every id
//    involved — never auto-picked, merged, or auto-linked. The caller
//    routes this to needs_review with every conflicting candidate shown.
//  - nothing resolves → CREATED — writes the record, the index entry,
//    and every pointer that has a real value (UPC/EAN may be blank;
//    signature is always present), all atomically.
//
// Returns a plain delimited string ("CREATED:<id>" / "EXISTING:<id>" /
// "CONFLICT:<id>,<id>,...") rather than JSON — Upstash auto-deserializes
// any JSON-shaped string a script returns, so Lua-script returns in this
// codebase are always kept as bare/delimited strings (see COMMIT_SCRIPT
// above).
// ---------------------------------------------------------------------

const GET_OR_CREATE_REFERENCE_PRODUCT_SCRIPT = `
local hasUpc = ARGV[1] == '1'
local hasEan = ARGV[2] == '1'
local newId = ARGV[3]

local upcId = false
local eanId = false
if hasUpc then
  upcId = redis.call('GET', KEYS[1])
end
if hasEan then
  eanId = redis.call('GET', KEYS[2])
end
local sigId = redis.call('GET', KEYS[3])

local found = {}
local seen = {}
if upcId then
  if not seen[upcId] then seen[upcId] = true table.insert(found, upcId) end
end
if eanId then
  if not seen[eanId] then seen[eanId] = true table.insert(found, eanId) end
end
if sigId then
  if not seen[sigId] then seen[sigId] = true table.insert(found, sigId) end
end

if #found > 1 then
  return 'CONFLICT:' .. table.concat(found, ',')
end
if #found == 1 then
  return 'EXISTING:' .. found[1]
end

redis.call('SET', KEYS[4], ARGV[4])
redis.call('ZADD', KEYS[5], ARGV[5], newId)
if hasUpc then
  redis.call('SET', KEYS[1], newId)
end
if hasEan then
  redis.call('SET', KEYS[2], newId)
end
redis.call('SET', KEYS[3], newId)
return 'CREATED:' .. newId
`;

export type GetOrCreateReferenceProductResult =
  | { status: "created"; id: string; product: PricingReferenceProduct }
  | { status: "existing"; id: string }
  | { status: "conflict"; ids: string[] };

export async function getOrCreateReferenceProductByIdentity(
  identity: { upc: string; ean: string; signature: string },
  newRecordInput: Omit<PricingReferenceProduct, "id" | "createdAt">
): Promise<GetOrCreateReferenceProductResult> {
  const hasUpc = identity.upc.length > 0;
  const hasEan = identity.ean.length > 0;
  const id = newId("refprod");
  const product: PricingReferenceProduct = { ...newRecordInput, id, createdAt: new Date().toISOString() };

  const keys = [
    hasUpc ? KEYS.referenceProductByUpc(identity.upc) : KEYS.referenceProductByUpc("__unused__"),
    hasEan ? KEYS.referenceProductByEan(identity.ean) : KEYS.referenceProductByEan("__unused__"),
    KEYS.referenceProductBySignature(identity.signature),
    KEYS.referenceProduct(id),
    KEYS.referenceProductsIndex,
  ];
  const args = [hasUpc ? "1" : "0", hasEan ? "1" : "0", id, JSON.stringify(product), String(Date.now())];

  const raw = await redis.eval<(string | number)[], string>(GET_OR_CREATE_REFERENCE_PRODUCT_SCRIPT, keys, args);
  if (raw.startsWith("CONFLICT:")) return { status: "conflict", ids: raw.slice("CONFLICT:".length).split(",") };
  if (raw.startsWith("EXISTING:")) return { status: "existing", id: raw.slice("EXISTING:".length) };
  await indexReferenceProductForSearch(product);
  await bumpCatalogVersion();
  return { status: "created", id: raw.slice("CREATED:".length), product };
}

// ---------------------------------------------------------------------
// Reads — always resolve through the current committed generation.
// ---------------------------------------------------------------------

export async function getCurrentOffer(supplierId: string, offerKey: string): Promise<SupplierOfferCurrent | null> {
  const generationId = await getCurrentGenerationId(supplierId);
  if (!generationId) return null;
  return (await redis.hget<SupplierOfferCurrent>(KEYS.offerCurrentHash(supplierId, generationId), offerKey)) ?? null;
}

export async function getOffersByProduct(productId: string): Promise<{ supplierId: string; offerKey: string }[]> {
  const members = (await redis.smembers(KEYS.offersByProduct(productId))) as string[];
  return members.map((m) => {
    const [supplierId, offerKey] = m.split("::");
    return { supplierId, offerKey };
  });
}

const DEFAULT_FRESHNESS_THRESHOLD_DAYS = 14;

function ageDaysOf(uploadedAt: string): number {
  return (Date.now() - new Date(uploadedAt).getTime()) / (1000 * 60 * 60 * 24);
}

/** The one authoritative "is this offer eligible to be a Best Price /
 *  leaderboard win" rule — every price-comparison surface (the two
 *  detail-page comparison functions below, and the Supplier Price
 *  Leaders / Buying Opportunities aggregation) calls this SAME function
 *  rather than re-deriving the condition, so there is never a second,
 *  competing "best price" definition.
 *
 *  priceUsdValid is checked deliberately: a missing/failed FX rate must
 *  exclude the offer entirely rather than letting it silently compare
 *  as if its raw non-USD price were USD (a confirmed pre-existing gap —
 *  see the priceUsdValid doc comment in pricing-types.ts). */
export function isActionableOffer(r: OfferComparisonRow): boolean {
  return (
    r.currentlyListed &&
    (r.quantity === null || r.quantity > 0) &&
    !r.isStale &&
    r.priceUsdValid &&
    (r.reviewStatus === "auto_matched" || r.reviewStatus === "confirmed")
  );
}

/** Splits raw comparison rows into actionable/nonActionable, sorts both
 *  by USD price ascending, and stamps every row with its
 *  differenceFromBestUsd relative to the actionable best (never the
 *  other way around — a nonActionable row's own price never becomes the
 *  baseline). Shared by getProductOfferComparison and
 *  getReferenceProductOfferComparison so the actionability rule and the
 *  "best price" definition live in exactly one place. */
function splitAndRankComparisonRows(rows: OfferComparisonRow[]): {
  actionable: OfferComparisonRow[];
  nonActionable: OfferComparisonRow[];
  bestPrice: OfferComparisonRow | null;
} {
  const actionableBase = rows.filter(isActionableOffer).sort((a, b) => a.priceUsd - b.priceUsd);
  const nonActionableBase = rows.filter((r) => !actionableBase.includes(r)).sort((a, b) => a.priceUsd - b.priceUsd);

  const best = actionableBase[0] ?? null;
  const withDiff = (r: OfferComparisonRow): OfferComparisonRow => ({
    ...r,
    differenceFromBestUsd: best ? Math.round((r.priceUsd - best.priceUsd) * 100) / 100 : null,
  });

  const actionable = actionableBase.map(withDiff);
  const nonActionable = nonActionableBase.map(withDiff);
  return { actionable, nonActionable, bestPrice: actionable[0] ?? null };
}

// Warns a comparison page that additional supplier options MIGHT exist,
// without ever auto-linking them — never included in actionable/
// bestPrice, purely informational. Deliberately scoped to
// needs_review/new_candidate only (never alias_conflict/barcode_
// conflict, which is a genuine disagreement signal, not "might be the
// same item"), and to valid product rows only (isValidProductRow —
// packaging/accessory rows are never counted as a "missing" fragrance
// offer). A full scan over every supplier's current unresolved offers,
// computed fresh per comparison-page view rather than a maintained
// index — accepted at the current catalog scale (low thousands of
// unresolved offers) rather than adding a new write-path index for a
// purely informational count.
//
// Matches via matchAgainstMasterCandidates against a pool of exactly
// ONE candidate (the Master Product itself) — deliberately NOT a raw
// computeIdentitySignature string comparison, which is confirmed
// elsewhere in this file to miss real matches on brand-token asymmetry
// (e.g. "Aventus by Creed" vs. "Creed Aventus") that checkHardGates'
// own brandsMatch containment fallback already resolves correctly.
async function countUnresolvedOffersMatchingIdentity(target: MasterCandidate, targetLabelText: string): Promise<number> {
  const [suppliers, products, referenceProducts] = await Promise.all([getSuppliers(), getProducts(), getAllReferenceProducts()]);
  const targetCode = (target.upc || target.ean).trim().toUpperCase();
  let count = 0;
  for (const s of suppliers) {
    const offers = Object.values(await getCommittedOffers(s.id));
    for (const o of offers) {
      if (o.currentlyListed === false) continue;
      if (o.productId || o.referenceProductId) continue;
      if (o.reviewStatus !== "needs_review" && o.reviewStatus !== "new_candidate") continue;
      if (!isValidProductRow(o)) continue;
      const effectiveBrand = resolveEffectiveBrand(o, products, referenceProducts);
      const attrs = extractAttributes(`${o.brand} ${o.description}`, effectiveBrand);

      // Exact UPC/EAN is matchSupplierRow's own strongest identity signal,
      // checked as a fast path BEFORE it ever reaches matchAgainstMasterCandidates
      // (see matchSupplierRow step 2) — so relying on matchAgainstMasterCandidates
      // alone here silently misses every offer that would actually resolve via
      // a barcode match (confirmed live: a supplier's own "brand" column can
      // hold a distributor name rather than the real fragrance house, which
      // fails the structured brand hard-gate even on an exact-barcode pair).
      // Mirrors matchSupplierRow's own guard exactly — a shared barcode isn't
      // trusted blindly if the free text is wildly different — rather than
      // the stricter attribute hard-gate, which barcode matches deliberately
      // bypass.
      const offerCode = (o.upc || o.ean).trim().toUpperCase();
      if (offerCode && targetCode && offerCode === targetCode && isPlausibleBarcode(offerCode)) {
        const text = bigramSimilarity(`${o.brand} ${o.description}`, targetLabelText);
        if (text >= BARCODE_CONFLICT_TEXT_FLOOR) {
          count++;
          continue;
        }
      }

      const result = matchAgainstMasterCandidates(attrs, [target]);
      if (result.outcome === "auto_match") count++;
    }
  }
  return count;
}

/** Every current supplier offer for one master product, split into
 *  actionable (eligible to be "Best Current Price") vs. everything else
 *  shown only for context — see pricing-matching.ts's plan §4. */
export async function getProductOfferComparison(productId: string): Promise<ProductOfferComparison> {
  const refs = await getOffersByProduct(productId);
  const [suppliers, offers, product] = await Promise.all([
    getSuppliers(),
    Promise.all(refs.map((r) => getCurrentOffer(r.supplierId, r.offerKey))),
    getProducts().then((ps) => ps.find((p) => p.id === productId) ?? null),
  ]);
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  const rows: OfferComparisonRow[] = [];
  for (let i = 0; i < refs.length; i++) {
    const offer = offers[i];
    if (!offer) continue;
    const rate = await getUsdRate(offer.currency);
    const converted = convertToUsd(offer.price, rate?.rate ?? null);
    const ageDays = ageDaysOf(offer.uploadedAt);
    rows.push({
      supplierId: refs[i].supplierId,
      supplierName: supplierById.get(refs[i].supplierId)?.name ?? "Unknown Supplier",
      offerKey: offer.offerKey,
      price: offer.price,
      currency: offer.currency,
      priceUsd: converted ?? offer.price,
      priceUsdValid: converted !== null,
      currentlyListed: offer.currentlyListed,
      quantity: offer.quantity,
      isStale: ageDays > DEFAULT_FRESHNESS_THRESHOLD_DAYS,
      ageDays: Math.round(ageDays * 10) / 10,
      uploadedAt: offer.uploadedAt,
      reviewStatus: offer.reviewStatus,
      differenceFromBestUsd: null, // overwritten by splitAndRankComparisonRows below
    });
  }

  const { actionable, nonActionable, bestPrice } = splitAndRankComparisonRows(rows);
  const unresolvedElsewhereCount = product
    ? await countUnresolvedOffersMatchingIdentity(
        {
          productId: product.id,
          referenceProductId: null,
          attrs: extractProductAttributes(product),
          upc: product.barcode,
          ean: product.barcode,
        },
        `${product.brand} ${product.name}`
      )
    : 0;
  return { productId, actionable, nonActionable, bestPrice, unresolvedElsewhereCount };
}

/** Backfill primitive for offers_by_reference_product — adds a
 *  supplier/offerKey membership that predates this index (originally:
 *  the one-time backfill script for the ~10 offers already tracked via
 *  "Track for Pricing" before this reverse index existed). Idempotent
 *  (SADD is naturally idempotent, safe to re-run).
 *
 *  Every ONGOING write goes through commitGeneration/resolveOfferManually
 *  instead, which keep this index and the generation commit/offer update
 *  atomic together — this primitive should never be a substitute for
 *  that. The one standing exception: createReferenceProductForOffer's
 *  own retry-safety branch (pricing-reference-linking.ts) calls this
 *  defensively when it finds an offer already linked, self-healing
 *  exactly this same class of gap (an offer whose referenceProductId is
 *  correct but whose reverse-index membership predates it — which is
 *  precisely the shape of every record this index bug left behind
 *  before applyReferenceLink was fixed to pass offersByReferenceProductOps). */
export async function backfillOfferByReferenceProduct(referenceProductId: string, supplierId: string, offerKey: string): Promise<void> {
  await redis.sadd(KEYS.offersByReferenceProduct(referenceProductId), `${supplierId}::${offerKey}`);
}

/** One-time cleanup primitive for the placeholder-barcode migration
 *  (isPlausibleBarcode, pricing-matching.ts) — clears a Master
 *  Product's own upc and/or ean field when it was corrupted with a
 *  supplier's placeholder text (e.g. "NO BARCODE") and removes the
 *  matching stale pointer key(s), so the record stops being a false
 *  collision magnet. Every OTHER field (brand/name/size/concentration/
 *  provenance/etc.) is untouched — this never implies the record itself
 *  is wrong, only that its barcode field was never a real barcode. Not
 *  used by any live request path. */
export async function clearReferenceProductPlaceholderFields(
  referenceProductId: string,
  clearUpc: boolean,
  clearEan: boolean
): Promise<void> {
  const existing = await getReferenceProduct(referenceProductId);
  if (!existing) return;
  const updated: PricingReferenceProduct = { ...existing };
  const deletions: string[] = [];
  if (clearUpc && existing.upc) {
    deletions.push(KEYS.referenceProductByUpc(existing.upc));
    updated.upc = "";
  }
  if (clearEan && existing.ean) {
    deletions.push(KEYS.referenceProductByEan(existing.ean));
    updated.ean = "";
  }
  await redis.set(KEYS.referenceProduct(referenceProductId), updated);
  if (deletions.length > 0) await redis.del(...deletions);
}

export async function getOffersByReferenceProduct(referenceProductId: string): Promise<{ supplierId: string; offerKey: string }[]> {
  const members = (await redis.smembers(KEYS.offersByReferenceProduct(referenceProductId))) as string[];
  return members.map((m) => {
    const [supplierId, offerKey] = m.split("::");
    return { supplierId, offerKey };
  });
}

/** Direct twin of getProductOfferComparison for a Master Product that
 *  has no linked real Product yet (or is being viewed by its Master
 *  identity directly) — same comparison logic, keyed by
 *  referenceProductId instead of productId. */
export async function getReferenceProductOfferComparison(referenceProductId: string): Promise<ReferenceProductOfferComparison> {
  const refs = await getOffersByReferenceProduct(referenceProductId);
  const [suppliers, offers, referenceProduct] = await Promise.all([
    getSuppliers(),
    Promise.all(refs.map((r) => getCurrentOffer(r.supplierId, r.offerKey))),
    getReferenceProduct(referenceProductId),
  ]);
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  const rows: OfferComparisonRow[] = [];
  for (let i = 0; i < refs.length; i++) {
    const offer = offers[i];
    if (!offer) continue;
    const rate = await getUsdRate(offer.currency);
    const converted = convertToUsd(offer.price, rate?.rate ?? null);
    const ageDays = ageDaysOf(offer.uploadedAt);
    rows.push({
      supplierId: refs[i].supplierId,
      supplierName: supplierById.get(refs[i].supplierId)?.name ?? "Unknown Supplier",
      offerKey: offer.offerKey,
      price: offer.price,
      currency: offer.currency,
      priceUsd: converted ?? offer.price,
      priceUsdValid: converted !== null,
      currentlyListed: offer.currentlyListed,
      quantity: offer.quantity,
      isStale: ageDays > DEFAULT_FRESHNESS_THRESHOLD_DAYS,
      ageDays: Math.round(ageDays * 10) / 10,
      uploadedAt: offer.uploadedAt,
      reviewStatus: offer.reviewStatus,
      differenceFromBestUsd: null, // overwritten by splitAndRankComparisonRows below
    });
  }

  const { actionable, nonActionable, bestPrice } = splitAndRankComparisonRows(rows);
  const unresolvedElsewhereCount = referenceProduct
    ? await countUnresolvedOffersMatchingIdentity(
        {
          productId: referenceProduct.productId,
          referenceProductId: referenceProduct.id,
          attrs: extractReferenceProductAttributes(referenceProduct),
          upc: referenceProduct.upc,
          ean: referenceProduct.ean,
        },
        `${referenceProduct.brand} ${referenceProduct.name}`
      )
    : 0;
  return { referenceProductId, actionable, nonActionable, bestPrice, unresolvedElsewhereCount };
}

// ---------------------------------------------------------------------
// Match Review — operates ONLY on currently-listed offers.
//
// A full upload's candidate generation legitimately retains every
// offerKey a previous generation had, flipping untouched ones to
// currentlyListed: false rather than deleting them (see the commit
// model above) — that's what makes "No Longer Listed" possible. A
// delisted offer is real history/audit data, never an operational
// concern: it must never contribute to Matched or Review Required
// counts, no matter what reviewStatus it was left with. Every function
// below filters `currentlyListed !== false` before classifying anything
// — this is the fix for a real incident where a flat, unfiltered count
// made "we don't carry this yet" look identical to "needs a human
// decision" (11,654 shown as one urgent queue, when only 399 were
// genuine matches/conflicts).
//
// Operating-model correction: there is no "New Product Candidate"
// bucket. "no existing match" resolves immediately, at processing time,
// into either matched (auto-created) or a genuinely-ambiguous offer —
// see pricing-process.ts. A legacy "new_candidate" row (pre-correction
// historical data, not yet migrated) and a "not_a_product" row (never a
// real product at all) are both deliberately invisible here — neither
// is counted, listed, or actionable through Match Review.
//
// Sep 2026 scoping change: a genuinely-ambiguous ("needs_review") offer
// is NOT automatically part of the active queue either. Most ambiguous
// supplier-catalog items will never be purchased — forcing a human
// decision on all of them just because a supplier listed them defeats
// the purpose of deferring work until it matters. review_required now
// means "alias_conflict/barcode_conflict (an existing confirmed
// identity going wrong — always urgent), OR a needs_review item an
// operator or workflow has explicitly flagged (reviewRequestedAt set)."
// Every ambiguous offer, flagged or not, still counts toward the quiet
// unresolvedOffers total and is still fully searchable — see
// searchUnresolvedOffers and requestIdentityResolution
// (pricing-product-linking.ts).
// ---------------------------------------------------------------------

const MATCHED_STATUSES: ReviewStatus[] = ["auto_matched", "confirmed"];
const REVIEW_REQUIRED_STATUSES: ReviewStatus[] = ["needs_review", "alias_conflict", "barcode_conflict"];
// alias_conflict/barcode_conflict are always active regardless of any
// flag — see the header comment above.
const ALWAYS_ACTIVE_REVIEW_STATUSES: ReviewStatus[] = ["alias_conflict", "barcode_conflict"];

function isActiveReviewRequired(o: Pick<SupplierOfferCurrent, "reviewStatus" | "reviewRequestedAt">): boolean {
  if (ALWAYS_ACTIVE_REVIEW_STATUSES.includes(o.reviewStatus)) return true;
  if (o.reviewStatus === "needs_review") return Boolean(o.reviewRequestedAt);
  return false;
}

function bucketOf(o: Pick<SupplierOfferCurrent, "reviewStatus" | "reviewRequestedAt">): MatchReviewBucket | "ignored" | null {
  if (MATCHED_STATUSES.includes(o.reviewStatus)) return "matched";
  if (isActiveReviewRequired(o)) return "review_required";
  if (o.reviewStatus === "ignored") return "ignored";
  return null;
}

/** The literal per-supplier diagnostic breakdown: currently-listed vs.
 *  no-longer-listed record counts, then the operational buckets computed
 *  only from the currently-listed set. One HGETALL per supplier (small
 *  supplier count at this business's scale) — same cost as the query
 *  this replaces, just classified correctly. */
export async function getMatchReviewSummary(): Promise<MatchReviewSummary> {
  const suppliers = await getSuppliers();
  const bySupplier: MatchReviewSummary["bySupplier"] = [];
  let matched = 0;
  let matchedCarried = 0;
  let matchedReferenceOnly = 0;
  let reviewRequired = 0;
  let unresolvedOffers = 0;
  let ignored = 0;

  for (const s of suppliers) {
    const offers = Object.values(await getCommittedOffers(s.id));
    const listed = offers.filter((o) => o.currentlyListed !== false);
    const noLongerListed = offers.length - listed.length;

    let sMatched = 0;
    let sMatchedCarried = 0;
    let sMatchedReferenceOnly = 0;
    let sReview = 0;
    let sUnresolved = 0;
    let sIgnored = 0;
    for (const o of listed) {
      const bucket = bucketOf(o);
      if (bucket === "matched") {
        sMatched++;
        // Sub-split by whether the resolved identity is physically
        // carried (productId set) vs. a Master identity AMORUH has
        // never stocked — computed from existing fields, no new
        // reviewStatus value.
        if (o.productId) sMatchedCarried++;
        else sMatchedReferenceOnly++;
      } else if (bucket === "ignored") sIgnored++;
      if (REVIEW_REQUIRED_STATUSES.includes(o.reviewStatus)) {
        sUnresolved++;
        if (bucket === "review_required") sReview++;
      }
    }

    bySupplier.push({
      supplierId: s.id,
      supplierName: s.name,
      currentlyListed: listed.length,
      noLongerListed,
      matched: sMatched,
      matchedCarried: sMatchedCarried,
      matchedReferenceOnly: sMatchedReferenceOnly,
      reviewRequired: sReview,
      unresolvedOffers: sUnresolved,
      quietlyUnresolved: sUnresolved - sReview,
      ignored: sIgnored,
    });
    matched += sMatched;
    matchedCarried += sMatchedCarried;
    matchedReferenceOnly += sMatchedReferenceOnly;
    reviewRequired += sReview;
    unresolvedOffers += sUnresolved;
    ignored += sIgnored;
  }

  return {
    matched,
    matchedCarried,
    matchedReferenceOnly,
    reviewRequired,
    unresolvedOffers,
    quietlyUnresolved: unresolvedOffers - reviewRequired,
    ignored,
    bySupplier,
  };
}

/** Paginated, filterable items for one Match Review tab — serves both
 *  buckets through the same function so there's one query path, not
 *  two. Never serializes more than `limit` items regardless of how
 *  large the bucket is. "review_required" here is the ACTIVE queue
 *  (see isActiveReviewRequired) — browsing every ambiguous offer,
 *  flagged or not, is searchUnresolvedOffers's job instead. */
export async function getMatchReviewItems(params: {
  bucket: MatchReviewBucket;
  supplierId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: MatchReviewItem[]; total: number }> {
  const { bucket, supplierId, search, limit = 50, offset = 0 } = params;
  const suppliers = await getSuppliers();
  const relevantSuppliers = supplierId ? suppliers.filter((s) => s.id === supplierId) : suppliers;
  const searchLower = search?.trim().toLowerCase();

  const matching: MatchReviewItem[] = [];
  for (const s of relevantSuppliers) {
    const offers = Object.values(await getCommittedOffers(s.id));
    for (const o of offers) {
      if (o.currentlyListed === false) continue;
      if (bucket === "matched" ? !MATCHED_STATUSES.includes(o.reviewStatus) : !isActiveReviewRequired(o)) continue;
      if (
        searchLower &&
        !o.description.toLowerCase().includes(searchLower) &&
        !o.brand.toLowerCase().includes(searchLower) &&
        !o.supplierSku.toLowerCase().includes(searchLower)
      ) {
        continue;
      }
      matching.push({
        supplierId: s.id,
        supplierName: s.name,
        offerKey: o.offerKey,
        description: o.description,
        brand: o.brand,
        price: o.price,
        currency: o.currency,
        quantity: o.quantity,
        upc: o.upc,
        reviewStatus: o.reviewStatus,
        matchConfidence: o.matchConfidence,
        productId: o.productId,
        candidateProductId: o.candidateProductId,
        candidateLabel: null,
        candidateReferenceProductId: o.candidateReferenceProductId ?? null,
        competingCandidates: o.competingCandidates,
        referenceProductId: o.referenceProductId,
        reviewRequestedAt: o.reviewRequestedAt ?? null,
      });
    }
  }

  const total = matching.length;
  const items = matching.slice(offset, offset + limit);
  return { items, total };
}

/** Single-offer lookup in the same MatchReviewItem shape — what the
 *  focused single-item resolution view (a workflow's
 *  requestIdentityResolution call) needs, without paging through a
 *  whole bucket to find one item. */
export async function getMatchReviewItemForOffer(supplierId: string, offerKey: string): Promise<MatchReviewItem | null> {
  const [offer, suppliers] = await Promise.all([getCurrentOffer(supplierId, offerKey), getSuppliers()]);
  if (!offer) return null;
  const supplier = suppliers.find((s) => s.id === supplierId);
  return {
    supplierId,
    supplierName: supplier?.name ?? "Unknown Supplier",
    offerKey: offer.offerKey,
    description: offer.description,
    brand: offer.brand,
    price: offer.price,
    currency: offer.currency,
    quantity: offer.quantity,
    upc: offer.upc,
    reviewStatus: offer.reviewStatus,
    matchConfidence: offer.matchConfidence,
    productId: offer.productId,
    candidateProductId: offer.candidateProductId,
    candidateLabel: null,
    candidateReferenceProductId: offer.candidateReferenceProductId ?? null,
    competingCandidates: offer.competingCandidates,
    referenceProductId: offer.referenceProductId,
    reviewRequestedAt: offer.reviewRequestedAt ?? null,
  };
}

// ---------------------------------------------------------------------
// Global search — plan §4. Generalizes the same "no productId and no
// referenceProductId" (still genuinely unresolved) text search
// getMatchReviewItems already does per-bucket into one shared function,
// callable from both Match Review and the global Pricing/Ordering
// search, rather than a second implementation.
// ---------------------------------------------------------------------

const UNRESOLVED_STATUSES: ReviewStatus[] = ["new_candidate", ...REVIEW_REQUIRED_STATUSES];

export interface UnresolvedOfferSearchResult {
  supplierId: string;
  supplierName: string;
  offerKey: string;
  description: string;
  brand: string;
  supplierSku: string;
  upc: string;
  ean: string;
  price: number;
  currency: string;
  quantity: number | null;
  /** Freshness — when this offer was last seen on an upload. */
  uploadedAt: string;
  reviewStatus: ReviewStatus;
  /** Whether this item is already in the active Review Required queue —
   *  lets the UI show "Send for Review" only when there's actually
   *  something to send. */
  reviewRequestedAt: string | null;
}

/** Any current, currently-listed offer that resolves to neither a real
 *  Product nor a Master Product — new_candidate/needs_review/
 *  alias_conflict/barcode_conflict. Deliberately excludes "ignored"
 *  (an operator's deliberate dismissal, not something search should
 *  keep resurfacing) and anything already matched/tracked (covered by
 *  the product/reference_product result types instead). Bounded by
 *  `limit` per the same reasoning as searchReferenceProducts — this
 *  scans every supplier's committed offers, which at this business's
 *  scale is a bounded, occasional-search cost, not a hot path. */
const UNRESOLVED_OFFER_SEARCH_MIN_SCORE = 0.35;

/** Ranked, word-order-tolerant search (quickTextSimilarity, same as the
 *  real-Product path) over every supplier's offers in parallel — an
 *  order of magnitude smaller population than the reference-product
 *  catalog (low thousands, not 13,000+), so a full ranked scan stays
 *  cheap without a dedicated index; re-benchmark and add one here too if
 *  that ever stops holding. Exact UPC/EAN still matches at full
 *  priority via the score bonus below. Scans every supplier's offers to
 *  completion (never truncates early once `limit` looks satisfied) so
 *  ranking is correct across the WHOLE population, not just the first
 *  supplier scanned. */
export async function searchUnresolvedOffers(query: string, limit = 20): Promise<UnresolvedOfferSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const qUpper = trimmed.toUpperCase();

  const suppliers = await getSuppliers();
  const offersBySupplier = await Promise.all(suppliers.map((s) => getCommittedOffers(s.id)));

  const scored: { offer: SupplierOfferCurrent; supplierId: string; supplierName: string; score: number }[] = [];
  for (let i = 0; i < suppliers.length; i++) {
    const s = suppliers[i];
    for (const o of Object.values(offersBySupplier[i])) {
      if (o.currentlyListed === false) continue;
      if (o.productId || o.referenceProductId) continue;
      if (!UNRESOLVED_STATUSES.includes(o.reviewStatus)) continue;
      const exactCode = (o.upc.trim().toUpperCase() === qUpper && qUpper.length > 0) || (o.ean.trim().toUpperCase() === qUpper && qUpper.length > 0);
      const score = exactCode ? 2 : quickTextSimilarity(trimmed, `${o.brand} ${o.description} ${o.supplierSku}`);
      if (score < UNRESOLVED_OFFER_SEARCH_MIN_SCORE) continue;
      scored.push({ offer: o, supplierId: s.id, supplierName: s.name, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ offer: o, supplierId, supplierName }) => ({
    supplierId,
    supplierName,
    offerKey: o.offerKey,
    description: o.description,
    brand: o.brand,
    supplierSku: o.supplierSku,
    upc: o.upc,
    ean: o.ean,
    price: o.price,
    currency: o.currency,
    quantity: o.quantity,
    uploadedAt: o.uploadedAt,
    reviewStatus: o.reviewStatus,
    reviewRequestedAt: o.reviewRequestedAt ?? null,
  }));
}

// ---------------------------------------------------------------------
// Supplier Price Leaders / Buying Opportunities leaderboard.
//
// Reuses isActionableOffer (the SAME rule the detail-page comparison
// functions use) rather than a second "best price" definition. Computed
// as one bulk in-memory pass over every supplier's current offers
// (fetched in parallel, once) instead of a per-product comparison-
// function call — a live regression test earlier in this project
// confirmed that calling getReferenceProductOfferComparison per product
// at catalog scale takes minutes, not milliseconds; this must never be
// repeated for a page load.
// ---------------------------------------------------------------------

/** Bumped by every write path that changes offer/Master-Product
 *  eligibility WITHOUT going through commitGeneration (relinking,
 *  unlinking, manual resolution, reference-product creation) — the
 *  second of the two signals (alongside each supplier's own generation
 *  seq) the leaderboard cache verifies before trusting itself as
 *  current. Failure-safe: if the INCR itself fails, the leaderboard
 *  cache is deleted directly as an independent fallback so a partial
 *  failure never leaves stale data looking current. The business
 *  operation that called this must never fail because of it. */
export async function bumpCatalogVersion(): Promise<void> {
  try {
    await redis.incr(KEYS.catalogVersion);
  } catch (err) {
    console.error("bumpCatalogVersion: INCR failed, falling back to direct cache invalidation", err);
    try {
      await redis.del(KEYS.leaderboard, KEYS.leaderboardMeta);
    } catch (err2) {
      console.error("bumpCatalogVersion: fallback cache DEL also failed — leaderboard may serve stale data until its TTL backstop expires", err2);
    }
  }
}

interface LeaderboardFingerprint {
  generationFingerprint: string;
  catalogVersion: number;
}

async function getCurrentLeaderboardFingerprint(suppliers: { id: string }[]): Promise<LeaderboardFingerprint> {
  const [seqs, catalogVersion] = await Promise.all([
    Promise.all(suppliers.map((s) => getCurrentGenerationSeq(s.id))),
    redis.get<number>(KEYS.catalogVersion),
  ]);
  return {
    generationFingerprint: suppliers.map((s, i) => `${s.id}:${seqs[i]}`).join(","),
    catalogVersion: catalogVersion ?? 0,
  };
}

interface IdentityMeta {
  isCarried: boolean;
  brand: string;
  name: string;
  sizeMl: number | null;
  concentration: string | null;
  productForm: string;
  upc: string;
  ean: string;
}

/** Pure aggregation — no cache read/write. Fetches every supplier's
 *  offers, the full reference-product catalog, and every real product
 *  ONCE, then groups in memory.
 *
 *  Deliberately scoped to getSuppliers()'s current list — an offer whose
 *  stored supplierId doesn't resolve to any real current supplier
 *  (confirmed live: a small number of reference products carry offer
 *  history from suppliers that were since deleted, e.g. test suppliers
 *  created and removed during this project's own development) is never
 *  counted as an "eligible supplier" here, correctly. Note this differs
 *  from the older getProductOfferComparison/getReferenceProductOfferComparison
 *  detail-page functions, which trust the offers_by_product/
 *  offers_by_reference_product reverse index directly via getCurrentOffer
 *  without cross-checking the offer's supplier still exists — a
 *  pre-existing characteristic of those functions, not something this
 *  leaderboard should inherit or fix here. */
async function computeSupplierPriceLeaderboardData(): Promise<Omit<LeaderboardData, "computedAt" | "generationFingerprint" | "catalogVersion">> {
  const suppliers = await getSuppliers();
  const [offersBySupplier, referenceProducts, products] = await Promise.all([
    Promise.all(suppliers.map((s) => getCommittedOffers(s.id))),
    getAllReferenceProducts(),
    getProducts(),
  ]);
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const referenceProductById = new Map(referenceProducts.map((rp) => [rp.id, rp]));
  const productById = new Map(products.map((p) => [p.id, p]));

  // Batch FX rates once per distinct currency present, instead of once
  // per offer.
  const currencies = new Set<string>();
  for (const offers of offersBySupplier) for (const o of Object.values(offers)) currencies.add(o.currency);
  const rateByCurrency = new Map<string, number | null>();
  await Promise.all(
    [...currencies].map(async (c) => {
      const r = await getUsdRate(c);
      rateByCurrency.set(c, r?.rate ?? null);
    })
  );

  interface Group {
    meta: IdentityMeta;
    rowsBySupplier: Map<string, OfferComparisonRow>; // cheapest actionable row per supplier
  }
  const groups = new Map<string, Group>();
  const supplierEligibleOfferCount = new Map<string, number>();

  function resolveIdentity(o: SupplierOfferCurrent): { key: string; meta: IdentityMeta } | null {
    if (o.productId) {
      const p = productById.get(o.productId);
      return {
        key: o.productId,
        meta: {
          isCarried: true,
          brand: p?.brand ?? "",
          name: p?.name ?? "",
          sizeMl: null,
          concentration: p?.concentration || null,
          productForm: "fragrance",
          upc: p?.barcode ?? "",
          ean: p?.barcode ?? "",
        },
      };
    }
    if (o.referenceProductId) {
      const rp = referenceProductById.get(o.referenceProductId);
      if (!rp) return null;
      if (rp.productId) {
        // Linked-pair rule: represented by the real Product's identity only.
        const p = productById.get(rp.productId);
        return {
          key: rp.productId,
          meta: {
            isCarried: true,
            brand: p?.brand ?? rp.brand,
            name: p?.name ?? rp.name,
            sizeMl: rp.sizeMl,
            concentration: p?.concentration || rp.concentration,
            productForm: rp.productForm,
            upc: p?.barcode ?? rp.upc,
            ean: p?.barcode ?? rp.ean,
          },
        };
      }
      return {
        key: rp.id,
        meta: {
          isCarried: false,
          brand: rp.brand,
          name: rp.name,
          sizeMl: rp.sizeMl,
          concentration: rp.concentration,
          productForm: rp.productForm,
          upc: rp.upc,
          ean: rp.ean,
        },
      };
    }
    return null;
  }

  for (let i = 0; i < suppliers.length; i++) {
    const supplierId = suppliers[i].id;
    for (const o of Object.values(offersBySupplier[i])) {
      const identity = resolveIdentity(o);
      if (!identity) continue; // unresolved offer -- never counted as a confirmed win

      const rate = rateByCurrency.get(o.currency) ?? null;
      const converted = convertToUsd(o.price, rate);
      const ageDays = ageDaysOf(o.uploadedAt);
      const row: OfferComparisonRow = {
        supplierId,
        supplierName: supplierById.get(supplierId)?.name ?? "Unknown Supplier",
        offerKey: o.offerKey,
        price: o.price,
        currency: o.currency,
        priceUsd: converted ?? o.price,
        priceUsdValid: converted !== null,
        currentlyListed: o.currentlyListed,
        quantity: o.quantity,
        isStale: ageDays > DEFAULT_FRESHNESS_THRESHOLD_DAYS,
        ageDays: Math.round(ageDays * 10) / 10,
        uploadedAt: o.uploadedAt,
        reviewStatus: o.reviewStatus,
        differenceFromBestUsd: null,
      };
      if (!isActionableOffer(row)) continue;

      let group = groups.get(identity.key);
      if (!group) {
        group = { meta: identity.meta, rowsBySupplier: new Map() };
        groups.set(identity.key, group);
      }
      const existing = group.rowsBySupplier.get(supplierId);
      if (!existing || row.priceUsd < existing.priceUsd) {
        if (!existing) supplierEligibleOfferCount.set(supplierId, (supplierEligibleOfferCount.get(supplierId) ?? 0) + 1);
        group.rowsBySupplier.set(supplierId, row);
      }
    }
  }

  const competitiveProducts: LeaderboardProductEntry[] = [];
  const singleSupplierProducts: LeaderboardSingleSupplierEntry[] = [];
  const perSupplier = new Map<
    string,
    { competitiveProductCount: number; outrightWins: number; ties: number; totalPerUnitSavingsUsd: number; winCount: number; singleSupplierOnlyCount: number }
  >();
  const ensureSupplier = (id: string) => {
    if (!perSupplier.has(id)) perSupplier.set(id, { competitiveProductCount: 0, outrightWins: 0, ties: 0, totalPerUnitSavingsUsd: 0, winCount: 0, singleSupplierOnlyCount: 0 });
    return perSupplier.get(id)!;
  };

  for (const [key, group] of groups) {
    const rows = [...group.rowsBySupplier.values()].sort((a, b) => a.priceUsd - b.priceUsd);
    if (rows.length < 2) {
      if (rows.length === 1) {
        const r = rows[0];
        singleSupplierProducts.push({
          identityKey: key,
          isCarried: group.meta.isCarried,
          brand: group.meta.brand,
          name: group.meta.name,
          sizeMl: group.meta.sizeMl,
          concentration: group.meta.concentration,
          supplierId: r.supplierId,
          supplierName: r.supplierName,
          priceUsd: r.priceUsd,
        });
        ensureSupplier(r.supplierId).singleSupplierOnlyCount++;
      }
      continue;
    }

    for (const r of rows) ensureSupplier(r.supplierId).competitiveProductCount++;

    const bestPriceUsd = Math.round(rows[0].priceUsd * 100) / 100;
    const winners = rows.filter((r) => Math.round(r.priceUsd * 100) / 100 === bestPriceUsd);
    const isTie = winners.length > 1;
    const secondBestRow = rows[winners.length] ?? null;
    const secondBestPriceUsd = secondBestRow ? secondBestRow.priceUsd : null;
    const perUnitAdvantageUsd = !isTie && secondBestPriceUsd !== null ? Math.round((secondBestPriceUsd - bestPriceUsd) * 100) / 100 : null;
    const perUnitAdvantagePct = !isTie && secondBestPriceUsd !== null && secondBestPriceUsd > 0 ? Math.round(((secondBestPriceUsd - bestPriceUsd) / secondBestPriceUsd) * 1000) / 10 : null;

    if (isTie) {
      for (const w of winners) ensureSupplier(w.supplierId).ties++;
    } else {
      const w = winners[0];
      const s = ensureSupplier(w.supplierId);
      s.outrightWins++;
      if (perUnitAdvantageUsd !== null) {
        s.totalPerUnitSavingsUsd += perUnitAdvantageUsd;
        s.winCount++;
      }
    }

    const offers: LeaderboardOfferRow[] = rows.map((r) => ({
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      offerKey: r.offerKey,
      priceUsd: r.priceUsd,
      quantity: r.quantity,
      uploadedAt: r.uploadedAt,
    }));

    competitiveProducts.push({
      identityKey: key,
      isCarried: group.meta.isCarried,
      brand: group.meta.brand,
      name: group.meta.name,
      sizeMl: group.meta.sizeMl,
      concentration: group.meta.concentration,
      productForm: group.meta.productForm,
      upc: group.meta.upc,
      ean: group.meta.ean,
      winningSupplierIds: winners.map((w) => w.supplierId),
      isTie,
      bestPriceUsd,
      secondBestPriceUsd,
      perUnitAdvantageUsd,
      perUnitAdvantagePct,
      eligibleSupplierCount: rows.length,
      offers,
    });
  }

  const supplierSummaries: SupplierLeaderboardSummary[] = suppliers.map((s) => {
    const stats = perSupplier.get(s.id) ?? { competitiveProductCount: 0, outrightWins: 0, ties: 0, totalPerUnitSavingsUsd: 0, winCount: 0, singleSupplierOnlyCount: 0 };
    return {
      supplierId: s.id,
      supplierName: s.name,
      competitiveProductCount: stats.competitiveProductCount,
      outrightWins: stats.outrightWins,
      ties: stats.ties,
      winRate: stats.competitiveProductCount > 0 ? Math.round((stats.outrightWins / stats.competitiveProductCount) * 1000) / 10 : 0,
      avgPerUnitSavingsUsd: stats.winCount > 0 ? Math.round((stats.totalPerUnitSavingsUsd / stats.winCount) * 100) / 100 : 0,
      totalPerUnitSavingsUsd: Math.round(stats.totalPerUnitSavingsUsd * 100) / 100,
      singleSupplierOnlyCount: stats.singleSupplierOnlyCount,
      currentEligibleOfferCount: supplierEligibleOfferCount.get(s.id) ?? 0,
    };
  });

  const outrightWinProductCount = competitiveProducts.filter((p) => !p.isTie).length;
  const tiedProductCount = competitiveProducts.filter((p) => p.isTie).length;
  const totals: LeaderboardTotals = {
    competitiveProductCount: competitiveProducts.length,
    outrightWinProductCount,
    tiedProductCount,
  };

  return { suppliers: supplierSummaries, totals, competitiveProducts, singleSupplierProducts };
}

const PUBLISH_LEADERBOARD_SCRIPT = `
local existingMeta = redis.call('GET', KEYS[1])
if existingMeta then
  local decoded = cjson.decode(existingMeta)
  if tonumber(decoded.catalogVersion) > tonumber(ARGV[1]) then
    return 'STALE'
  end
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
return 'OK'
`;

/** Compare-and-set publish — never lets an older computation overwrite
 *  a newer one. Compares only the small meta blob (catalogVersion), not
 *  the full leaderboard payload, in Lua. */
async function publishLeaderboardIfNewer(data: LeaderboardData): Promise<void> {
  const meta = { catalogVersion: data.catalogVersion, generationFingerprint: data.generationFingerprint, computedAt: data.computedAt };
  await redis.eval<(string | number)[], "OK" | "STALE">(
    PUBLISH_LEADERBOARD_SCRIPT,
    [KEYS.leaderboardMeta, KEYS.leaderboard],
    [String(data.catalogVersion), JSON.stringify(meta), JSON.stringify(data)]
  );
}

async function recomputeAndPublishLeaderboard(): Promise<LeaderboardData> {
  const suppliers = await getSuppliers();
  const before = await getCurrentLeaderboardFingerprint(suppliers);
  let computed = await computeSupplierPriceLeaderboardData();
  let fingerprint = before;

  // Re-verify immediately before publishing/returning -- if anything
  // changed DURING computation, recompute once more rather than publish
  // a result that's already stale by the time it's done.
  const after = await getCurrentLeaderboardFingerprint(suppliers);
  if (after.generationFingerprint !== before.generationFingerprint || after.catalogVersion !== before.catalogVersion) {
    computed = await computeSupplierPriceLeaderboardData();
    fingerprint = await getCurrentLeaderboardFingerprint(suppliers);
  }

  const data: LeaderboardData = { ...computed, computedAt: new Date().toISOString(), ...fingerprint };
  await publishLeaderboardIfNewer(data);

  // If a concurrent, newer computation published in the meantime, return
  // THAT instead of this caller's own (possibly now-stale) result.
  const stored = await redis.get<LeaderboardData>(KEYS.leaderboard);
  return stored && stored.catalogVersion >= data.catalogVersion ? stored : data;
}

/** The one entry point every leaderboard consumer (Supplier Price
 *  Leaders, Buying Opportunities, the drill-down, search's price
 *  preview) reads through. Verifies BOTH freshness signals before
 *  trusting the cache; recomputes synchronously and republishes if
 *  either is stale or missing — never knowingly returns stale data as
 *  current. */
export async function getSupplierPriceLeaderboard(): Promise<LeaderboardData> {
  const suppliers = await getSuppliers();
  const [cached, current] = await Promise.all([redis.get<LeaderboardData>(KEYS.leaderboard), getCurrentLeaderboardFingerprint(suppliers)]);
  if (cached && cached.generationFingerprint === current.generationFingerprint && cached.catalogVersion === current.catalogVersion) {
    return cached;
  }
  return recomputeAndPublishLeaderboard();
}

/** Lightweight accessor for search's price preview — one leaderboard
 *  cache read (freshness-verified, recomputed if stale, same as any
 *  other consumer), then O(1) in-memory map lookups. Never a live
 *  per-result comparison-function call (confirmed live to cost 60+
 *  seconds for a single search when it was tried that way). */
export async function getPriceLeaderboardPreview(): Promise<{
  byProductId: Map<string, { bestPriceUsd: number; eligibleSupplierCount: number }>;
  byReferenceProductId: Map<string, { bestPriceUsd: number; eligibleSupplierCount: number }>;
}> {
  const board = await getSupplierPriceLeaderboard();
  const byProductId = new Map<string, { bestPriceUsd: number; eligibleSupplierCount: number }>();
  const byReferenceProductId = new Map<string, { bestPriceUsd: number; eligibleSupplierCount: number }>();
  const assign = (map: Map<string, { bestPriceUsd: number; eligibleSupplierCount: number }>, key: string, bestPriceUsd: number, eligibleSupplierCount: number) =>
    map.set(key, { bestPriceUsd, eligibleSupplierCount });

  for (const p of board.competitiveProducts) assign(p.isCarried ? byProductId : byReferenceProductId, p.identityKey, p.bestPriceUsd, p.eligibleSupplierCount);
  for (const p of board.singleSupplierProducts) assign(p.isCarried ? byProductId : byReferenceProductId, p.identityKey, p.priceUsd, 1);

  return { byProductId, byReferenceProductId };
}
