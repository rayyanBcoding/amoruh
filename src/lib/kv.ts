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
} as const;
