import { getValidAccessToken } from "./auth";
import { TIKTOK_ENV, type TikTokEnv } from "./config";
import { getOrderDetails, orderIdOf, searchRecentOrders, SAMPLE_MAX } from "./orders";
import { keyPaths, sanitize } from "./sanitize";
import { getAuthorizedShops } from "./shops";

// Read-only sample of the most recent orders, returned ONLY in sanitized form so
// real field names / types / shapes can be inspected without exposing buyer data
// (see sanitize.ts: deny-listed subtrees redacted, unknown scalars hidden).
// Raw TikTok responses stay in memory and are discarded. Nothing is written to
// TikTok, to Redis, to the catalog, sales ledger or inventory.

export interface SanitizedSample {
  generatedAt: string;
  env: TikTokEnv;
  shop: { name: string; region: string; id: string };
  requestedCount: number;
  search: { returned: number; totalCount: number | null; requestId: string | null };
  detail: { returned: number; requestId: string | null };
  searchShape: string[];
  detailShape: string[];
  searchSanitized: unknown;
  detailSanitized: unknown;
}

export async function fetchSanitizedSample(rawCount = 5): Promise<SanitizedSample> {
  const count = Math.min(Math.max(Math.floor(Number(rawCount)) || 5, 1), SAMPLE_MAX);
  const { accessToken, conn } = await getValidAccessToken();
  const shops = conn.shops.length ? conn.shops : (await getAuthorizedShops(accessToken)).shops;
  const shop = shops[0];
  if (!shop?.cipher) throw new Error("No authorized shop (with a shop cipher) found for this connection.");

  const search = await searchRecentOrders({ accessToken, shopCipher: shop.cipher, pageSize: count });
  const ids = search.orders.map(orderIdOf).filter((x): x is string => !!x);
  const detail = await getOrderDetails({ accessToken, shopCipher: shop.cipher, orderIds: ids });

  return {
    generatedAt: new Date().toISOString(),
    env: TIKTOK_ENV,
    shop: { name: shop.name, region: shop.region, id: shop.id },
    requestedCount: count,
    search: { returned: search.orders.length, totalCount: search.totalCount, requestId: search.requestId },
    detail: { returned: detail.orders.length, requestId: detail.requestId },
    searchShape: keyPaths(search.orders),
    detailShape: keyPaths(detail.orders),
    searchSanitized: sanitize(search.orders, "orders"),
    detailSanitized: sanitize(detail.orders, "orders"),
  };
}
