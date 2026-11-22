import batch from "./data/intake-live-enrichment.json";
import type { Product, LiveNotes } from "./types";
import { getLiveNotesView, buildLiveNotes } from "./live-notes";
import { retailIdentity, retailReferenceError, isVerifiedRetail, type RetailReference, type RetailIdentity } from "./retail-reference";

interface EnrichmentRow {
  productId: string;
  identity: RetailIdentity;
  liveNotes: Pick<LiveNotes, "keyNotes" | "vibe" | "bestFor"> | null;
  liveNotesSourceUrl: string | null;
  notesIssue: string | null;
  retailReference: Omit<RetailReference, "status" | "currency"> & { status: string; currency: string };
}

export interface EnrichmentCounts {
  newLiveNotes: number; verifiedRetailReference: number; notVerifiedRetailReference: number;
  preservedLiveNotes: number; preservedRetailReference: number; skipped: number;
  notesUnresolved: { productId: string; reason: string }[];
}
// The default allowlist remains the original two-intake batch. Catalog scope
// supplies its separately reviewed export allowlist. Replays fill missing data;
// no fuzzy matching or discovery of unreviewed products at apply time.
export function planIntakeEnrichment(current: Product[], rows: readonly EnrichmentRow[] = batch) {
  const counts: EnrichmentCounts = { newLiveNotes: 0, verifiedRetailReference: 0, notVerifiedRetailReference: 0, preservedLiveNotes: 0, preservedRetailReference: 0, skipped: 0, notesUnresolved: [] };
  const byId = new Map(current.map((p) => [p.id, p]));
  const changed = new Map<string, Product>();
  for (const row of rows) { // fixed exact-identity allowlist, never fuzzy matching
    const p = byId.get(row.productId);
    if (!p || !(p.inventory > 0) || retailIdentity(p) !== retailIdentity(row.identity)) { counts.skipped++; continue; }
    const next = { ...p };
    if (getLiveNotesView(p) !== null || p.liveNotes?.check) counts.preservedLiveNotes++;
    else if (row.liveNotes) {
      next.liveNotes = buildLiveNotes(row.liveNotes, { source: "researched" });
      counts.newLiveNotes++;
    } else counts.notesUnresolved.push({ productId: p.id, reason: row.notesIssue ?? "Exact fragrance notes not verified." });
    // Unknown pre-existing reference shapes and all operator edits are preserved.
    if (p.retailReference && (p.retailReference.status !== "not_verified" || p.retailReference.manuallyEdited)) counts.preservedRetailReference++;
    else if (JSON.stringify(p.retailReference) !== JSON.stringify(row.retailReference)) {
      let r = row.retailReference as RetailReference;
      if (r.status === "verified" && !isVerifiedRetail({ ...p, retailReference: r })) {
        r = { ...r, status: "not_verified", priceCents: null, referenceSize: null, retailer: null, sourceUrl: null, verificationNotes: "Staged retail evidence is stale or invalid; recheck before quoting." };
      }
      const error = retailReferenceError(r, p.brand);
      if (error || r.identityKey !== retailIdentity(p)) throw new Error(`Invalid staged reference for ${p.id}: ${error ?? "identity"}`);
      next.retailReference = r;
      if (r.status === "verified") counts.verifiedRetailReference++; else counts.notVerifiedRetailReference++;
    }
    changed.set(p.id, next);
  }
  return { products: current.map((p) => changed.get(p.id) ?? p), result: counts };
}
