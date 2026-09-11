import { getPOs } from "./intake-db";
import { getUploadsForSupplier, getCurrentGenerationId, getAliasesForSupplier } from "./pricing-db";

/** Shared by the delete-eligibility GET route (a preview for the UI) and
 *  the DELETE handler on the supplier route (which re-runs this exact
 *  check immediately before deleting — never trusts a prior GET result,
 *  same "re-verify at commit time" discipline used everywhere else in
 *  this codebase). A supplier is only eligible for hard delete when NONE
 *  of its history exists anywhere: no uploads, no committed
 *  offers/snapshots (checking the currentGenerationId pointer covers
 *  both, since it's set the moment any generation is ever committed and
 *  never unset — and a PricingReferenceProduct link can only exist on
 *  an offer, so this transitively covers that too), no learned aliases,
 *  and no POs (which transitively covers lots/transactions/receiving
 *  events, since those only ever originate from a PO). */
export async function checkSupplierDeleteEligibility(supplierId: string): Promise<{ eligible: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  const [uploads, generationId, aliases, pos] = await Promise.all([
    getUploadsForSupplier(supplierId, 1),
    getCurrentGenerationId(supplierId),
    getAliasesForSupplier(supplierId),
    getPOs(),
  ]);

  if (uploads.length > 0) reasons.push("This supplier has price-list upload history.");
  if (generationId) reasons.push("This supplier has committed offers (and possibly tracked reference-product links).");
  if (aliases.length > 0) reasons.push("This supplier has learned product-matching aliases.");
  const supplierPOs = pos.filter((po) => po.supplierId === supplierId);
  if (supplierPOs.length > 0) {
    reasons.push(`This supplier has ${supplierPOs.length} purchase order${supplierPOs.length === 1 ? "" : "s"} on file.`);
  }

  return { eligible: reasons.length === 0, reasons };
}
