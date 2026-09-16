import { redis } from "./kv";
import type {
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
  SupplierPriceUpload,
  UploadStatus,
} from "./pricing-types";
import { getSuppliers } from "./intake-db";
import { getUsdRate, convertToUsd } from "./pricing-fx";

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
 *  never-referenced generation id if the upload later fails. */
export async function writeCandidateGeneration(
  supplierId: string,
  generationId: string,
  offers: Record<string, SupplierOfferCurrent>
): Promise<void> {
  const key = KEYS.offerCurrentHash(supplierId, generationId);
  const entries = Object.entries(offers);
  const CHUNK = 200;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = Object.fromEntries(entries.slice(i, i + CHUNK));
    if (Object.keys(chunk).length > 0) await redis.hset(key, chunk);
  }
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
  return redis.eval<(string | number)[], "OK" | "STALE_GENERATION">(COMMIT_SCRIPT, keys, args);
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
  ]);
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

const REFERENCE_SEARCH_PAGE_SIZE = 200;
// Protection against a pathological collection with zero matches, NOT a
// definition of search scope — a real collection (even "thousands" of
// listings) is scanned to completion well under this. A reference
// product created long ago must be exactly as findable as one created
// moments ago; this must never silently become "search the newest N."
const REFERENCE_SEARCH_MAX_SCANNED = 20000;

/** Exact UPC/EAN hit first (O(1)); otherwise pages the FULL index in
 *  bounded chunks, checking brand/name/description/upc/ean/concentration,
 *  until `limit` matches are found or the index is exhausted. */
export async function searchReferenceProducts(query: string, limit = 20): Promise<PricingReferenceProduct[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const [byUpc, byEan] = await Promise.all([getReferenceProductByUpc(trimmed), getReferenceProductByEan(trimmed)]);
  if (byUpc) return [byUpc];
  if (byEan) return [byEan];

  const q = trimmed.toLowerCase();
  const results: PricingReferenceProduct[] = [];
  let cursor = 0;
  let scanned = 0;
  while (results.length < limit && scanned < REFERENCE_SEARCH_MAX_SCANNED) {
    const ids = (await redis.zrange(KEYS.referenceProductsIndex, cursor, cursor + REFERENCE_SEARCH_PAGE_SIZE - 1)) as string[];
    if (ids.length === 0) break; // index exhausted
    const records = await Promise.all(ids.map(getReferenceProduct));
    for (const r of records) {
      if (!r) continue;
      const haystack = `${r.brand} ${r.name} ${r.description} ${r.upc} ${r.ean} ${r.concentration ?? ""}`.toLowerCase();
      if (haystack.includes(q)) {
        results.push(r);
        if (results.length >= limit) break;
      }
    }
    scanned += ids.length;
    cursor += REFERENCE_SEARCH_PAGE_SIZE;
  }
  return results;
}

/** Fetches the ENTIRE reference-product catalog — the matching pool a
 *  supplier upload's row loop needs (pricing-process.ts) and the pool
 *  buildMasterCandidatePool dedupes against linked real Products. Same
 *  bounded-page-to-exhaustion shape as searchReferenceProducts's full
 *  scan, just collecting every record instead of filtering by text. At
 *  this business's scale (hundreds to low thousands of Master Products)
 *  this is a bounded, once-per-upload cost, not a hot per-request path. */
export async function getAllReferenceProducts(): Promise<PricingReferenceProduct[]> {
  const PAGE = 200;
  const all: PricingReferenceProduct[] = [];
  let cursor = 0;
  for (;;) {
    const ids = (await redis.zrange(KEYS.referenceProductsIndex, cursor, cursor + PAGE - 1)) as string[];
    if (ids.length === 0) break;
    const records = await Promise.all(ids.map(getReferenceProduct));
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
  const actionableBase = rows
    .filter(
      (r) =>
        r.currentlyListed &&
        (r.quantity === null || r.quantity > 0) &&
        !r.isStale &&
        (r.reviewStatus === "auto_matched" || r.reviewStatus === "confirmed")
    )
    .sort((a, b) => a.priceUsd - b.priceUsd);
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

/** Every current supplier offer for one master product, split into
 *  actionable (eligible to be "Best Current Price") vs. everything else
 *  shown only for context — see pricing-matching.ts's plan §4. */
export async function getProductOfferComparison(productId: string): Promise<ProductOfferComparison> {
  const refs = await getOffersByProduct(productId);
  const [suppliers, offers] = await Promise.all([
    getSuppliers(),
    Promise.all(refs.map((r) => getCurrentOffer(r.supplierId, r.offerKey))),
  ]);
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  const rows: OfferComparisonRow[] = [];
  for (let i = 0; i < refs.length; i++) {
    const offer = offers[i];
    if (!offer) continue;
    const rate = await getUsdRate(offer.currency);
    const priceUsd = convertToUsd(offer.price, rate?.rate ?? null) ?? offer.price;
    const ageDays = ageDaysOf(offer.uploadedAt);
    rows.push({
      supplierId: refs[i].supplierId,
      supplierName: supplierById.get(refs[i].supplierId)?.name ?? "Unknown Supplier",
      offerKey: offer.offerKey,
      price: offer.price,
      currency: offer.currency,
      priceUsd,
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
  return { productId, actionable, nonActionable, bestPrice };
}

/** One-time backfill primitive for offers_by_reference_product — adds a
 *  supplier/offerKey membership that predates this index (see the
 *  one-time backfill script; the ~10 offers already tracked via "Track
 *  for Pricing" before this reverse index existed). Idempotent (SADD is
 *  naturally idempotent, safe to re-run). No other code path should ever
 *  call this directly — every ONGOING write goes through
 *  commitGeneration/resolveOfferManually instead, which keep this index
 *  and the generation commit atomic together. */
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
  const [suppliers, offers] = await Promise.all([
    getSuppliers(),
    Promise.all(refs.map((r) => getCurrentOffer(r.supplierId, r.offerKey))),
  ]);
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  const rows: OfferComparisonRow[] = [];
  for (let i = 0; i < refs.length; i++) {
    const offer = offers[i];
    if (!offer) continue;
    const rate = await getUsdRate(offer.currency);
    const priceUsd = convertToUsd(offer.price, rate?.rate ?? null) ?? offer.price;
    const ageDays = ageDaysOf(offer.uploadedAt);
    rows.push({
      supplierId: refs[i].supplierId,
      supplierName: supplierById.get(refs[i].supplierId)?.name ?? "Unknown Supplier",
      offerKey: offer.offerKey,
      price: offer.price,
      currency: offer.currency,
      priceUsd,
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
  return { referenceProductId, actionable, nonActionable, bestPrice };
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
      ignored: sIgnored,
    });
    matched += sMatched;
    matchedCarried += sMatchedCarried;
    matchedReferenceOnly += sMatchedReferenceOnly;
    reviewRequired += sReview;
    unresolvedOffers += sUnresolved;
    ignored += sIgnored;
  }

  return { matched, matchedCarried, matchedReferenceOnly, reviewRequired, unresolvedOffers, ignored, bySupplier };
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
export async function searchUnresolvedOffers(query: string, limit = 20): Promise<UnresolvedOfferSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const q = trimmed.toLowerCase();

  const suppliers = await getSuppliers();
  const results: UnresolvedOfferSearchResult[] = [];
  for (const s of suppliers) {
    if (results.length >= limit) break;
    const offers = Object.values(await getCommittedOffers(s.id));
    for (const o of offers) {
      if (results.length >= limit) break;
      if (o.currentlyListed === false) continue;
      if (o.productId || o.referenceProductId) continue;
      if (!UNRESOLVED_STATUSES.includes(o.reviewStatus)) continue;
      const haystack = `${o.description} ${o.brand} ${o.supplierSku} ${o.upc} ${o.ean}`.toLowerCase();
      if (!haystack.includes(q)) continue;
      results.push({
        supplierId: s.id,
        supplierName: s.name,
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
      });
    }
  }
  return results;
}
