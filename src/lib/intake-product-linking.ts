import { createProduct, getProducts } from "./db";
import { getPO, getPOLines, savePOLines, recomputePOFromLines } from "./intake-db";
import { isLineConfirmed } from "./intake-review";
import {
  getCommittedOffers,
  getReferenceProductByEan,
  getReferenceProductByUpc,
  linkReferenceProductToProduct,
} from "./pricing-db";
import { checkHardGates, extractProductAttributes, extractReferenceProductAttributes } from "./pricing-matching";
import type { PurchaseOrderLine } from "./intake-types";
import type { Product } from "./types";

// ---------------------------------------------------------------------
// V2 Phase 1 §6 — the ONLY place Intake ever sets PricingReferenceProduct
// .productId. Tried in this exact priority, stopping at the first hit;
// never guesses, and never blocks or alters receiving either way — every
// call site below treats this as purely advisory and continues
// regardless of what it returns.
// ---------------------------------------------------------------------

/** A. Direct lineage (strongest) — this SAME supplier's own current
 *  offer for an exact UPC/EAN match already carries a referenceProductId
 *  (set by Match Review's Track/Link actions, or by Pricing/Ordering's
 *  own auto-creation) — that's definitionally the identity an operator
 *  or the matcher already confirmed, so it's linked directly, no extra
 *  gate needed.
 *
 *  C. An existing confirmed identity — this supplier's own current
 *  offer is already confirmed/auto_matched to THIS EXACT real Product
 *  (an operator's own prior Match Review decision) and that SAME offer
 *  also tracks a Master Product — both facts independently confirmed
 *  already, so linking them together isn't a guess either.
 *
 *  Both A and C only ever look at offers for THIS supplier — the
 *  literal price list this PO's items were bought from — which is why
 *  they're checked before the global barcode search in B. */
async function findLineageReferenceProductId(supplierId: string, upc: string, productId: string): Promise<string | null> {
  const offers = Object.values(await getCommittedOffers(supplierId)).filter((o) => o.currentlyListed !== false);

  if (upc) {
    const byBarcode = offers.find((o) => (o.upc && o.upc.toUpperCase() === upc) || (o.ean && o.ean.toUpperCase() === upc));
    if (byBarcode?.referenceProductId) return byBarcode.referenceProductId; // A
  }

  const confirmedForThisProduct = offers.find(
    (o) => o.productId === productId && o.referenceProductId && (o.reviewStatus === "confirmed" || o.reviewStatus === "auto_matched")
  );
  if (confirmedForThisProduct?.referenceProductId) return confirmedForThisProduct.referenceProductId; // C

  return null;
}

/** B. Exact UPC/EAN against ANY Master Product, globally, but ONLY ever
 *  trusted alongside a passing structural gate check — a bare barcode
 *  hit alone is never trusted blindly, since supplier barcode data can
 *  be wrong (same caution as the auto-creation get-or-create primitive's
 *  own barcode-conflict handling). */
async function findGlobalBarcodeReferenceProductId(product: Product, upc: string): Promise<string | null> {
  if (!upc) return null;
  const candidate = (await getReferenceProductByUpc(upc)) ?? (await getReferenceProductByEan(upc));
  if (!candidate || candidate.productId) return null; // already linked elsewhere — not this hook's decision to make
  const gate = checkHardGates(extractProductAttributes(product), extractReferenceProductAttributes(candidate));
  return gate.passes ? candidate.id : null;
}

/** The hook itself — call after a real Product is created or manually
 *  linked for a receiving line. D (multiple structurally-plausible
 *  candidates, or none) is simply "do nothing," never a guess: this
 *  function only ever WRITES a link when A, B, or C is unambiguous. */
export async function linkMasterProductForReceivedItem(
  product: Product,
  line: Pick<PurchaseOrderLine, "upc">,
  supplierId: string
): Promise<void> {
  try {
    const upc = (line.upc || product.barcode || "").trim().toUpperCase();

    const lineageId = await findLineageReferenceProductId(supplierId, upc, product.id);
    if (lineageId) {
      await linkReferenceProductToProduct(lineageId, product.id);
      return;
    }

    const barcodeId = await findGlobalBarcodeReferenceProductId(product, upc);
    if (barcodeId) {
      await linkReferenceProductToProduct(barcodeId, product.id);
      return;
    }
    // D — nothing authoritative found; leave unlinked for later
    // reconciliation. Receiving already completed regardless.
  } catch {
    // This is purely additive — never let it fail the receiving flow
    // it's attached to.
  }
}

// ---------------------------------------------------------------------
// Server-side create-and-link for a PO that already exists (has real
// persisted PurchaseOrderLines) — used by PO Detail's single-item and
// bulk "Create New Product From Invoice" actions.
//
// Everything happens in one server-side pass per line: revalidate against
// the CURRENT catalog, create-or-link, patch the line, recompute PO
// totals. The browser is never the thing holding "I created product X,
// now let me go PATCH line Y" as two separate steps — if that second
// step failed, the product would be real but invisible from the PO that
// caused it to exist.
//
// Idempotent by construction, not by a separate ledger: the candidate
// sku/barcode this function would create is deterministic for a given
// line (the line's own UPC, or a fallback derived from the line's own
// id), so a retry's revalidation step finds whatever a previous attempt
// already created and links to it instead of creating a second one.
// ---------------------------------------------------------------------

export interface CreateAndLinkResult {
  lineId: string;
  status: "created" | "linked_existing" | "needs_review" | "failed";
  productId?: string;
  product?: Product;
  error?: string;
}

export async function createAndLinkProductForLine(
  poId: string,
  lineId: string,
  productOverrides?: Partial<Product>
): Promise<CreateAndLinkResult> {
  const po = await getPO(poId);
  if (!po) return { lineId, status: "failed", error: "Purchase order not found." };
  if (po.status === "closed") return { lineId, status: "failed", error: "This PO is closed." };

  const lines = await getPOLines(poId);
  const lineIdx = lines.findIndex((l) => l.id === lineId);
  if (lineIdx === -1) return { lineId, status: "failed", error: "Line not found." };
  const line = lines[lineIdx];

  const products = await getProducts();
  const existingProductIds = new Set(products.map((p) => p.id));

  // Already resolved to a real, existing product — nothing to do. This
  // is what makes retries/double-clicks safe: a line a prior attempt
  // already linked is simply skipped.
  if (isLineConfirmed(line, existingProductIds)) {
    const product = products.find((p) => p.id === line.productId)!;
    await linkMasterProductForReceivedItem(product, line, po.supplierId);
    return { lineId, status: "linked_existing", productId: product.id, product };
  }

  const upc = (productOverrides?.barcode ?? line.upc ?? "").trim();
  const fallbackSku = `NEW-${lineId.slice(-8).toUpperCase()}`;
  const candidateSku = (productOverrides?.sku ?? upc ?? fallbackSku).trim();
  const candidateBarcode = (productOverrides?.barcode ?? upc ?? candidateSku).trim();

  // Revalidate against the CURRENT catalog before creating anything —
  // covers both "someone already added this UPC" and "a previous,
  // partially-failed attempt at this exact line already created it."
  const exactMatch = products.find(
    (p) =>
      (candidateBarcode && p.barcode.toUpperCase() === candidateBarcode.toUpperCase()) ||
      p.sku.toUpperCase() === candidateSku.toUpperCase()
  );

  let product: Product;
  let matchType: PurchaseOrderLine["matchType"];

  if (exactMatch) {
    product = exactMatch;
    matchType = "manual";
  } else {
    const spec: Partial<Product> = {
      sku: candidateSku,
      barcode: candidateBarcode,
      brand: line.brand,
      name: line.name,
      size: line.size,
      concentration: line.concentration,
      description: line.rawDescription,
      cost: line.unitCost,
      status: "draft",
      ...productOverrides,
      // Creating the catalog record must never add inventory — that only
      // happens later, when Phase 2 receiving confirms physical arrival.
      // Enforced here regardless of what productOverrides contains.
      inventory: 0,
    };
    try {
      product = await createProduct(spec);
    } catch (err) {
      return {
        lineId,
        status: "failed",
        error: err instanceof Error ? err.message : "Could not create this product.",
      };
    }
    matchType = "new_product";
  }

  const updatedLines = [...lines];
  updatedLines[lineIdx] = { ...line, productId: product.id, matchType };
  await savePOLines(poId, updatedLines);
  await recomputePOFromLines(poId);
  await linkMasterProductForReceivedItem(product, line, po.supplierId);

  return {
    lineId,
    status: exactMatch ? "linked_existing" : "created",
    productId: product.id,
    product,
  };
}
