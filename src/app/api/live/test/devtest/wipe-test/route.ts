import { NextResponse } from "next/server";
import { redis, KEYS as CoreKeys } from "@/lib/kv";
import { getProducts, saveProducts } from "@/lib/db";
import { KEYS as IntakeKeys, getAllInventoryTransactions } from "@/lib/intake-db";
import { deleteTestSession, getTestSession } from "@/lib/test-live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY — devtest only. Exact-ID-scoped cleanup for Test Live Mode
// verification data. Removed before merging this branch's PR.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const requestedProductIds: string[] = Array.isArray(body?.productIds) ? body.productIds : [];
  const testSessionIds: string[] = Array.isArray(body?.testSessionIds) ? body.testSessionIds : [];

  const allProducts = await getProducts();
  const productIds = requestedProductIds.filter((pid) => allProducts.some((p) => p.id === pid && p.sku.includes("TEST_")));

  const keysToDelete: string[] = [];
  for (const pid of productIds) {
    keysToDelete.push(IntakeKeys.lots(pid), CoreKeys.productVersion(pid), `amoruh:sales:aggregate:${pid}`, `amoruh:sales:by_product:${pid}`);
  }
  if (keysToDelete.length > 0) await redis.del(...keysToDelete);

  const remainingProducts = allProducts.filter((p) => !productIds.includes(p.id));
  if (remainingProducts.length !== allProducts.length) await saveProducts(remainingProducts);

  const txns = await getAllInventoryTransactions();
  const filteredTxns = txns.filter((t) => !productIds.includes(t.productId));
  if (filteredTxns.length !== txns.length) await redis.set(IntakeKeys.inventoryTransactions, filteredTxns);

  // Test sessions: end (if still active) then hard-delete each.
  for (const sid of testSessionIds) {
    const session = await getTestSession(sid);
    if (session && session.status === "active") {
      await redis.del("amoruh:testlive:active_session_id");
      await redis.set(`amoruh:testlive:session:${sid}`, { ...session, status: "ended", endedAt: new Date().toISOString() });
    }
    try {
      await deleteTestSession(sid);
    } catch {
      // best-effort cleanup
    }
  }

  return NextResponse.json({ ok: true });
}
