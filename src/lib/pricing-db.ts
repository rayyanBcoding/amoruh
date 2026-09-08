import { redis } from "./kv";
import type {
  MatchReviewItem,
  OfferComparisonRow,
  ProductOfferComparison,
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
    needsReview: 0,
    newCandidates: 0,
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

export async function commitGeneration(input: {
  supplierId: string;
  uploadId: string;
  seq: number;
  generationId: string;
  finishedUpload: SupplierPriceUpload;
  newAliases: SupplierAlias[];
  offersByProductOps: OffersByProductOp[];
}): Promise<"OK" | "STALE_GENERATION"> {
  const keys = [
    KEYS.currentGenerationId(input.supplierId),
    KEYS.currentGenerationSeq(input.supplierId),
    KEYS.upload(input.uploadId),
    KEYS.aliases(input.supplierId),
    ...input.offersByProductOps.map((o) => KEYS.offersByProduct(o.productId)),
  ];
  const args = [
    String(input.seq),
    input.generationId,
    JSON.stringify(input.finishedUpload),
    JSON.stringify(input.newAliases),
    ...input.offersByProductOps.flatMap((o) => [o.op, o.member]),
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
}): Promise<void> {
  const generationId = await getCurrentGenerationId(input.supplierId);
  if (!generationId) throw new Error("This supplier has no committed price list to update yet.");

  const keys = [
    KEYS.offerCurrentHash(input.supplierId, generationId),
    KEYS.aliases(input.supplierId),
    ...input.offersByProductOps.map((o) => KEYS.offersByProduct(o.productId)),
  ];
  const args = [
    input.offerKey,
    JSON.stringify(input.updatedOffer),
    JSON.stringify(input.newAliases),
    ...input.offersByProductOps.flatMap((o) => [o.op, o.member]),
  ];
  await redis.eval<(string | number)[], string>(RESOLVE_OFFER_SCRIPT, keys, args);
}

// ---------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------

export async function getAliasesForSupplier(supplierId: string): Promise<SupplierAlias[]> {
  return (await redis.get<SupplierAlias[]>(KEYS.aliases(supplierId))) ?? [];
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
    });
  }

  const actionable = rows
    .filter(
      (r) =>
        r.currentlyListed &&
        (r.quantity === null || r.quantity > 0) &&
        !r.isStale &&
        (r.reviewStatus === "auto_matched" || r.reviewStatus === "confirmed")
    )
    .sort((a, b) => a.priceUsd - b.priceUsd);
  const nonActionable = rows
    .filter((r) => !actionable.includes(r))
    .sort((a, b) => a.priceUsd - b.priceUsd);

  return { productId, actionable, nonActionable, bestPrice: actionable[0] ?? null };
}

/** Enumerates every supplier's current generation for the Match Review
 *  queue + dashboard counts. Bounded by supplier count (small at this
 *  business's scale) x that supplier's catalog size. */
export async function getAllCurrentOffers(): Promise<{ supplierId: string; offer: SupplierOfferCurrent }[]> {
  const suppliers = await getSuppliers();
  const results: { supplierId: string; offer: SupplierOfferCurrent }[] = [];
  for (const s of suppliers) {
    const offers = await getCommittedOffers(s.id);
    for (const offer of Object.values(offers)) {
      results.push({ supplierId: s.id, offer });
    }
  }
  return results;
}

export async function getMatchReviewQueue(): Promise<MatchReviewItem[]> {
  const all = await getAllCurrentOffers();
  const suppliers = await getSuppliers();
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));
  const REVIEW_STATUSES: ReviewStatus[] = ["needs_review", "new_candidate", "alias_conflict", "barcode_conflict"];

  return all
    .filter(({ offer }) => REVIEW_STATUSES.includes(offer.reviewStatus))
    .map(({ supplierId, offer }) => ({
      supplierId,
      supplierName: supplierById.get(supplierId)?.name ?? "Unknown Supplier",
      offerKey: offer.offerKey,
      description: offer.description,
      brand: offer.brand,
      price: offer.price,
      currency: offer.currency,
      upc: offer.upc,
      reviewStatus: offer.reviewStatus,
      matchConfidence: offer.matchConfidence,
      candidateProductId: offer.candidateProductId,
      candidateLabel: null,
    }));
}
