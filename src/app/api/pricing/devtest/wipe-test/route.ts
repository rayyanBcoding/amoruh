import { NextResponse } from "next/server";
import { redis } from "@/lib/kv";
import { getProducts, saveProducts } from "@/lib/db";
import { getSuppliers } from "@/lib/intake-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY — devtest only. Exact-ID-scoped cleanup for Pricing
// Reference Product verification data. Removed before merging this
// branch's PR.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const supplierIds: string[] = Array.isArray(body?.supplierIds) ? body.supplierIds : [];
  const referenceProductIds: string[] = Array.isArray(body?.referenceProductIds) ? body.referenceProductIds : [];
  const referenceProductUpcs: string[] = Array.isArray(body?.referenceProductUpcs) ? body.referenceProductUpcs : [];
  const referenceProductEans: string[] = Array.isArray(body?.referenceProductEans) ? body.referenceProductEans : [];
  const productIds: string[] = Array.isArray(body?.productIds) ? body.productIds : [];

  const keysToDelete: string[] = [];

  // Suppliers: only ever touch ones whose NAME is confirmed TEST_.
  const allSuppliers = await getSuppliers();
  const testSuppliers = allSuppliers.filter((s) => supplierIds.includes(s.id) && s.name.startsWith("TEST_"));
  for (const s of testSuppliers) {
    const genId = await redis.get<string>(`amoruh:pricing:current_generation_id:${s.id}`);
    if (genId) keysToDelete.push(`amoruh:pricing:offer_current:${s.id}:${genId}`);
    keysToDelete.push(
      `amoruh:pricing:current_generation_id:${s.id}`,
      `amoruh:pricing:current_generation_seq:${s.id}`,
      `amoruh:pricing:aliases:${s.id}`,
      `amoruh:pricing:upload_seq:${s.id}`,
      `amoruh:pricing:uploads_by_supplier:${s.id}`
    );
  }
  const remainingSuppliers = allSuppliers.filter((s) => !testSuppliers.some((t) => t.id === s.id));
  if (remainingSuppliers.length !== allSuppliers.length) {
    await redis.set("amoruh:intake:suppliers", remainingSuppliers);
  }

  for (const id of referenceProductIds) {
    keysToDelete.push(`amoruh:pricing:reference_product:${id}`);
    await redis.zrem("amoruh:pricing:reference_products_index", id);
  }
  for (const upc of referenceProductUpcs) {
    if (upc) keysToDelete.push(`amoruh:pricing:reference_product_by_upc:${upc}`);
  }
  for (const ean of referenceProductEans) {
    if (ean) keysToDelete.push(`amoruh:pricing:reference_product_by_ean:${ean}`);
  }

  if (keysToDelete.length > 0) await redis.del(...keysToDelete);

  if (productIds.length > 0) {
    const allProducts = await getProducts();
    const testProductIds = productIds.filter((pid) => allProducts.some((p) => p.id === pid && p.sku.includes("TEST_")));
    const remaining = allProducts.filter((p) => !testProductIds.includes(p.id));
    if (remaining.length !== allProducts.length) await saveProducts(remaining);
  }

  return NextResponse.json({ ok: true, deletedKeys: keysToDelete.length });
}
