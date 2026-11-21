import batch from "./data/intake-live-enrichment.json";
import type { Product } from "./types";
import { getLiveNotesView, buildLiveNotes } from "./live-notes";
import { retailIdentity, retailReferenceError, isVerifiedRetail, type RetailReference } from "./retail-reference";

export interface EnrichmentCounts {
  newLiveNotes: number; verifiedRetailReference: number; notVerifiedRetailReference: number;
  preservedLiveNotes: number; preservedRetailReference: number; skipped: number;
  notesUnresolved: { productId: string; reason: string }[];
}
// Fixed allowlist of 56 products from the two newest receipts in the supplied
// production export. No matching by fuzzy name; replays only fill missing data.
export function planIntakeEnrichment(current: Product[]) {
  const counts: EnrichmentCounts = { newLiveNotes: 0, verifiedRetailReference: 0, notVerifiedRetailReference: 0, preservedLiveNotes: 0, preservedRetailReference: 0, skipped: 0, notesUnresolved: [] };
  const byId = new Map(current.map((p) => [p.id, p]));
  const changed = new Map<string, Product>();
  for (const row of batch) { // newest receipts first
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
