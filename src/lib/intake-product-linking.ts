import { createProduct, getProducts } from "./db";
import { getPO, getPOLines, savePOLines, recomputePOFromLines } from "./intake-db";
import { isLineConfirmed } from "./intake-review";
import type { PurchaseOrderLine } from "./intake-types";
import type { Product } from "./types";

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

  return {
    lineId,
    status: exactMatch ? "linked_existing" : "created",
    productId: product.id,
    product,
  };
}
