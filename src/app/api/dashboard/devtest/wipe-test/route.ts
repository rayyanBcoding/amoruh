import { NextResponse } from "next/server";
import { redis, KEYS as CoreKeys } from "@/lib/kv";
import { getProducts, saveProducts } from "@/lib/db";
import { KEYS as IntakeKeys, getAllInventoryTransactions, getPOs, getAllReceivingEvents } from "@/lib/intake-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY — devtest only. Exact-ID-scoped cleanup for Dashboard
// Pass B verification data — never a broad pattern delete. Removed
// before merging this branch's PR.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const requestedProductIds: string[] = Array.isArray(body?.productIds) ? body.productIds : [];
  const sessionIds: string[] = Array.isArray(body?.sessionIds) ? body.sessionIds : [];
  const saleIds: string[] = Array.isArray(body?.saleIds) ? body.saleIds : [];
  const presentationIds: string[] = Array.isArray(body?.presentationIds) ? body.presentationIds : [];
  const poIds: string[] = Array.isArray(body?.poIds) ? body.poIds : [];

  const allProducts = await getProducts();
  const productIds = requestedProductIds.filter((pid) => allProducts.some((p) => p.id === pid && p.sku.includes("TEST_")));

  const keysToDelete: string[] = [];
  for (const pid of productIds) {
    keysToDelete.push(IntakeKeys.lots(pid), CoreKeys.productVersion(pid), `amoruh:sales:aggregate:${pid}`, `amoruh:sales:by_product:${pid}`);
  }
  for (const sid of sessionIds) {
    keysToDelete.push(`amoruh:live:session:${sid}`, `amoruh:live:session_state:${sid}`, `amoruh:live:presentations_by_session:${sid}`);
    await redis.zrem("amoruh:live:sessions_index", sid);
  }
  for (const said of saleIds) {
    keysToDelete.push(`amoruh:sales:${said}`);
    await redis.zrem("amoruh:sales:all", said);
  }
  for (const pid of presentationIds) {
    keysToDelete.push(`amoruh:live:presentation:${pid}`);
  }

  if (keysToDelete.length > 0) await redis.del(...keysToDelete);

  const remainingProducts = allProducts.filter((p) => !productIds.includes(p.id));
  if (remainingProducts.length !== allProducts.length) await saveProducts(remainingProducts);

  const txns = await getAllInventoryTransactions();
  const filteredTxns = txns.filter((t) => !productIds.includes(t.productId));
  if (filteredTxns.length !== txns.length) await redis.set(IntakeKeys.inventoryTransactions, filteredTxns);

  if (poIds.length > 0) {
    const pos = await getPOs();
    const testPoIds = poIds.filter((id) => pos.some((p) => p.id === id && p.poNumber.startsWith("TEST-")));
    const remainingPos = pos.filter((p) => !testPoIds.includes(p.id));
    if (remainingPos.length !== pos.length) await redis.set(IntakeKeys.pos, remainingPos);

    const events = await getAllReceivingEvents();
    const remainingEvents = events.filter((e) => !testPoIds.includes(e.poId));
    if (remainingEvents.length !== events.length) await redis.set(IntakeKeys.receivingEvents, remainingEvents);
  }

  const activeId = await redis.get<string>("amoruh:live:active_session_id");
  if (activeId && sessionIds.includes(activeId)) {
    await redis.del("amoruh:live:active_session_id");
  }

  return NextResponse.json({ ok: true, deletedKeys: keysToDelete.length });
}
