import { fetchRecentOrdersRaw, WINDOW_DEFAULT, WINDOW_MAX } from "./auction-sample";
import { importOrders, type ImportSummary } from "./order-store";

// One MANUAL import of the most recent orders into the TikTok record store.
// Deliberately capped at one window (<= WINDOW_MAX orders): this is NOT a backfill.
// Read-only toward TikTok; writes only amoruh:tiktok:{env}:* records.

export async function importRecentOrders(windowSize: number = WINDOW_DEFAULT): Promise<ImportSummary & { requestIds: (string | null)[] }> {
  const size = Math.min(Math.max(Math.floor(Number(windowSize)) || WINDOW_DEFAULT, 1), WINDOW_MAX);
  const { orders, requestIds } = await fetchRecentOrdersRaw(size);
  const summary = await importOrders(orders.slice(0, size));
  return { ...summary, requestIds };
}
