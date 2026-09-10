import { NextResponse } from "next/server";
import { redis, KEYS as CoreKeys } from "@/lib/kv";
import { getProducts, saveProducts } from "@/lib/db";
import { KEYS as IntakeKeys, getAllInventoryTransactions } from "@/lib/intake-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY — devtest only. Exact-ID-scoped cleanup for verification test
// data created against this preview's (shared) Redis — never a broad
// pattern delete. Removed before merging this branch's PR.
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const productIds: string[] = Array.isArray(body?.productIds) ? body.productIds : [];
  const sessionIds: string[] = Array.isArray(body?.sessionIds) ? body.sessionIds : [];
  const saleIds: string[] = Array.isArray(body?.saleIds) ? body.saleIds : [];
  const presentationIds: string[] = Array.isArray(body?.presentationIds) ? body.presentationIds : [];

  const keysToDelete: string[] = [];
  for (const pid of productIds) {
    keysToDelete.push(IntakeKeys.lots(pid), CoreKeys.productVersion(pid), `amoruh:sales:aggregate:${pid}`, `amoruh:sales:by_product:${pid}`);
  }
  for (const sid of sessionIds) {
    keysToDelete.push(`amoruh:live:session:${sid}`, `amoruh:live:session_state:${sid}`, `amoruh:live:presentations_by_session:${sid}`);
  }
  for (const said of saleIds) {
    keysToDelete.push(`amoruh:sales:${said}`);
    await redis.zrem("amoruh:sales:all", said);
  }
  for (const pid of presentationIds) {
    keysToDelete.push(`amoruh:live:presentation:${pid}`);
  }
  for (const sid of sessionIds) {
    await redis.zrem("amoruh:live:sessions_index", sid);
  }

  if (keysToDelete.length > 0) {
    await redis.del(...keysToDelete);
  }

  // Remove test products from the catalog + purge their sale/txn records.
  const products = await getProducts();
  const remaining = products.filter((p) => !productIds.includes(p.id));
  if (remaining.length !== products.length) await saveProducts(remaining);

  const txns = await getAllInventoryTransactions();
  const filteredTxns = txns.filter((t) => !productIds.includes(t.productId));
  if (filteredTxns.length !== txns.length) {
    await redis.set(IntakeKeys.inventoryTransactions, filteredTxns);
  }

  // Clear the active-session pointer if it still points at a test session.
  const activeId = await redis.get<string>("amoruh:live:active_session_id");
  if (activeId && sessionIds.includes(activeId)) {
    await redis.del("amoruh:live:active_session_id");
  }

  return NextResponse.json({ ok: true, deletedKeys: keysToDelete.length });
}
