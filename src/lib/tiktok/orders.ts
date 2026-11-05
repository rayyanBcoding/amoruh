import { callOpenApi, type ClientDeps } from "./client";
import { TIKTOK_API } from "./config";

// Read-only order access (scope seller.order.info). Milestone 1 returns the RAW
// parsed TikTok objects to the caller IN MEMORY ONLY so the sample script can
// pass them through the sanitizer. Raw responses contain buyer personal data and
// must never be stored, logged or returned by a route.

export const SAMPLE_MAX = 10;

/** Most recent orders, newest first. POST, but it only reads. */
export async function searchRecentOrders(
  args: { accessToken: string; shopCipher: string; pageSize?: number; pageToken?: string },
  deps: ClientDeps = {}
): Promise<{ orders: unknown[]; nextPageToken: string | null; totalCount: number | null; requestId: string | null }> {
  const pageSize = Math.min(Math.max(args.pageSize ?? 5, 1), SAMPLE_MAX);
  const { data, requestId } = await callOpenApi<{ orders?: unknown[]; next_page_token?: string; total_count?: number }>(
    {
      method: "POST",
      path: TIKTOK_API.orderSearchPath,
      accessToken: args.accessToken,
      query: { shop_cipher: args.shopCipher, page_size: pageSize, sort_field: "create_time", sort_order: "DESC", page_token: args.pageToken },
      body: {},
    },
    deps
  );
  return { orders: data.orders ?? [], nextPageToken: data.next_page_token || null, totalCount: data.total_count ?? null, requestId };
}

/** Full detail for up to 50 order ids (ids are STRINGS). */
export async function getOrderDetails(
  args: { accessToken: string; shopCipher: string; orderIds: string[] },
  deps: ClientDeps = {}
): Promise<{ orders: unknown[]; requestId: string | null }> {
  if (args.orderIds.length === 0) return { orders: [], requestId: null };
  if (args.orderIds.length > 50) throw new Error("Order detail accepts at most 50 ids per call.");
  const { data, requestId } = await callOpenApi<{ orders?: unknown[] }>(
    {
      method: "GET",
      path: TIKTOK_API.orderDetailPath,
      accessToken: args.accessToken,
      query: { ids: args.orderIds.join(","), shop_cipher: args.shopCipher },
    },
    deps
  );
  return { orders: data.orders ?? [], requestId };
}

/** Pulls the order id out of a search result without assuming more than `id`. */
export function orderIdOf(order: unknown): string | null {
  if (order && typeof order === "object" && "id" in order) {
    const id = (order as { id: unknown }).id;
    if (typeof id === "string" && id) return id;
    if (typeof id === "number") return String(id);
  }
  return null;
}
