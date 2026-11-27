import batch from "./data/retail-coverage.json";
import type { Product, LiveNotes } from "./types";
import { buildLiveNotes, getLiveNotesView } from "./live-notes";
import { retailIdentity, retailPriceView, retailReferenceError, type RetailIdentity, type RetailReference } from "./retail-reference";

export const RETAIL_COVERAGE_VERSION = "2026-11-27-v2";
export interface CoverageRow {
  productId: string; identity: RetailIdentity; retailReference: RetailReference;
  liveNotes: LiveNotes | null; notesIssue: string | null; interpretation: string | null;
}
export const coverageRows = batch as CoverageRow[];

export function coverageTotals(products: Product[]) {
  const totals = { totalCatalogProducts: products.length, productsWithLiveNotes: 0, verifiedRetail: 0, estimatedRetail: 0, manualRetail: 0, missingRetailPrice: 0, inStock: 0 };
  for (const p of products) {
    if (p.inventory > 0) totals.inStock++;
    if (getLiveNotesView(p)?.keyNotes.some((n) => n.trim())) totals.productsWithLiveNotes++;
    const view = retailPriceView(p);
    if (!view) totals.missingRetailPrice++;
    else if (view.status === "verified") totals.verifiedRetail++;
    else if (view.status === "manual") totals.manualRetail++;
    else totals.estimatedRetail++;
  }
  return totals;
}

/** Entire catalog, deliberately NO stock/status filter. Apply at most `limit`
 * changed products in the current catalog order. Already completed records are
 * skipped on replay, so stopping/retrying needs no external cursor/job state.
 * updateCatalogMetadata provides whole-catalog CAS and protected-field checks. */
export function planRetailCoverage(current: Product[], limit = 25, rows: readonly CoverageRow[] = coverageRows) {
  const byId = new Map(rows.map((r) => [r.productId, r]));
  const unresolvedNotes: { id: string; product: string; reason: string }[] = [];
  const missing: { id: string; product: string; reason: string }[] = [];
  const proposed = new Map<string, Product>();
  let changedNotes = 0, changedRetail = 0;
  for (const p of current) {
    const label = `${p.brand} ${p.name}`;
    const row = byId.get(p.id);
    if (!row || retailIdentity(row.identity) !== retailIdentity(p)) {
      if (!retailPriceView(p)) missing.push({ id:p.id, product:label, reason:"Not in the reviewed exact-identity batch, or identity changed. Research/update the manifest; never reuse a different variant." });
      if (!getLiveNotesView(p)?.keyNotes.length) unresolvedNotes.push({id:p.id,product:label,reason:"Exact identity not in the reviewed batch."});
      continue;
    }
    let next = p;
    // Preserve all existing saved notes, fallback key notes and review flags.
    // A missing structured card can reuse good fallback notes while adding only
    // the reviewed vibe/best-for; old fragrance/selling fields remain untouched.
    const view = getLiveNotesView(p);
    if (!p.liveNotes && row.liveNotes) {
      next = { ...next, liveNotes: buildLiveNotes({ ...row.liveNotes, keyNotes: view?.keyNotes.length ? view.keyNotes : row.liveNotes.keyNotes }, { source:view?.source === "fallback" ? "ai_draft" : row.liveNotes.source, check:row.liveNotes.check || view?.check, now:()=>new Date(row.liveNotes!.updatedAt) }) };
    } else if (!view?.keyNotes.length && !p.liveNotes?.check && p.liveNotes?.source !== "manual" && row.liveNotes) {
      next = { ...next, liveNotes: row.liveNotes };
    }
    if (!getLiveNotesView(next)?.keyNotes.length) unresolvedNotes.push({id:p.id,product:label,reason:row.notesIssue ?? "Existing notes/review flag preserved."});

    const r = p.retailReference;
    const positive = !!r && Number.isSafeInteger(r.priceCents) && (r.priceCents ?? 0) > 0;
    const protectedPrice = !!r && (r.status === "verified" || (positive && (r.status === "manual" || r.manuallyEdited)));
    // Explicit user policy: empty legacy not_verified placeholders, including
    // the operator-cleared Gold tester, may receive an estimate. Positive manual
    // prices and every existing verified reference are never overwritten.
    const upgradeEstimate = r?.status === "estimated" && retailPriceView({...p,retailReference:row.retailReference})?.status === "verified";
    if (!protectedPrice && (!retailPriceView(p) || upgradeEstimate)) {
      let proposedReference = row.retailReference;
      const error = retailReferenceError(proposedReference, p.brand);
      if (error || proposedReference.identityKey !== retailIdentity(p) || proposedReference.concentration !== p.concentration) throw Error(`Invalid retail recipe ${p.id}: ${error ?? "identity"}`);
      // A recorded exact observation may age while the PR waits to be applied.
      // Preserve the price as an estimate, never falsely call stale research verified.
      if (proposedReference.status === "verified" && retailPriceView({...p,retailReference:proposedReference})?.status === "estimated") {
        proposedReference = { ...proposedReference, status:"estimated", verificationNotes:`Earlier approved-source observation used as an estimate; recheck before treating as exact. ${proposedReference.verificationNotes}`.slice(0,1000) };
      }
      next = { ...next, retailReference: proposedReference };
    }
    if (!retailPriceView(next)) missing.push({id:p.id,product:label,reason:protectedPrice ? "Protected verified/manual price does not match current identity or is invalid; operator correction required." : "No usable reviewed retail recipe."});
    if (JSON.stringify(next) !== JSON.stringify(p)) proposed.set(p.id, next);
  }
  const selected = new Set([...proposed.keys()].slice(0, Math.max(0,limit)));
  const products = current.map((p) => {
    const next = selected.has(p.id) ? proposed.get(p.id)! : p;
    if (next.liveNotes !== p.liveNotes) changedNotes++;
    if (next.retailReference !== p.retailReference) changedRetail++;
    return next;
  });
  return { products, result: {
    version:RETAIL_COVERAGE_VERSION, changedProducts:selected.size, changedNotes, changedRetail,
    pendingProducts:proposed.size-selected.size, currentTotals:coverageTotals(current), totals:coverageTotals(products),
    projectedTotals:coverageTotals(current.map((p)=>proposed.get(p.id) ?? p)), missing, unresolvedNotes,
  } };
}
