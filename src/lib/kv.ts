import { Redis } from "@upstash/redis";

// Single shared Redis client for the whole app.
//
// Uses AMORUH_REDIS_URL / AMORUH_REDIS_TOKEN (explicit names we control)
// rather than the generic KV_REST_API_* names Vercel's Upstash integration
// injects, so there's no ambiguity if multiple Redis credentials ever end
// up in the same env (e.g. while migrating between databases).
declare global {
  var __amoruhRedis: Redis | undefined;
}

export const redis: Redis =
  globalThis.__amoruhRedis ??
  new Redis({
    url: process.env.AMORUH_REDIS_URL!,
    token: process.env.AMORUH_REDIS_TOKEN!,
  });

globalThis.__amoruhRedis = redis;

// Redis keys used across the app. Centralized here so nothing typos a key.
export const KEYS = {
  products: "amoruh:products",
  state: "amoruh:state",
  /** Bumped by every mutating write; the SSE route polls this cheaply to
   *  detect changes across serverless instances without a shared process. */
  version: "amoruh:version",
  /** Per-product optimistic-concurrency counter — bumped by every write
   *  that changes THIS product's inventory (Phase 2 receiving,
   *  markProductSold). A bare counter, not a copy of inventory itself —
   *  there's still only one source of truth for the actual number. See
   *  sales-analytics.ts for the compare-and-swap that reads this. */
  productVersion: (productId: string) => `amoruh:product_version:${productId}`,
} as const;

const SCAN_COUNT_HINT = 500;
// Upstash refuses KEYS outright once the database's TOTAL key count gets
// large enough — regardless of how few keys the specific pattern would
// actually match — so there is no size below which KEYS stays safe long
// term. SCAN is the correct, supported replacement: same "every key
// matching this pattern" result, but walked in bounded batches via a
// cursor instead of one unbounded server-side pass. `count` is only a
// hint to Redis about batch size, not a page-size guarantee, so this
// loops until the server reports cursor "0" (scan complete) rather than
// assuming any fixed number of round trips.
export async function scanKeys(matchPattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const result: [string, string[]] = await redis.scan(cursor, { match: matchPattern, count: SCAN_COUNT_HINT });
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== "0");
  return keys;
}
