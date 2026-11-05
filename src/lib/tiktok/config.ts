// TikTok Shop integration — configuration in ONE place (hosts, API versions,
// environment resolution, Redis key namespace). Nothing here reads a secret
// value into a log or a client bundle; secrets are read lazily by the server
// code that needs them (`requireAppCredentials`, crypto.ts).
//
// Phase 1 is strictly READ-ONLY toward TikTok. See client.ts for the allow-list.

export type TikTokEnv = "prod" | "preview" | "dev";
export type EnvLike = Record<string, string | undefined>;

/** Which TikTok environment this process is. Derived from Vercel's own
 *  `VERCEL_ENV`, so a laptop (no VERCEL_ENV) can NEVER resolve to "prod" —
 *  production tokens live only under the `prod` namespace, written and read
 *  only by the production deployment. `TIKTOK_ENV` may narrow dev/preview but
 *  can never be used to select prod. */
export function resolveTikTokEnv(env: EnvLike = process.env): TikTokEnv {
  if (env.VERCEL_ENV === "production") return "prod";
  if (env.VERCEL_ENV === "preview") return "preview";
  return "dev";
}

export const TIKTOK_ENV: TikTokEnv = resolveTikTokEnv();

/** Every TikTok Redis key is `amoruh:tiktok:{env}:...` so dev / preview / prod
 *  can share one Redis database without ever overwriting each other. */
export function tiktokKey(suffix: string, env: TikTokEnv = TIKTOK_ENV): string {
  return `amoruh:tiktok:${env}:${suffix}`;
}

export const TIKTOK_HOSTS = {
  /** Token get / refresh (all markets). */
  auth: "https://auth.tiktok-shops.com",
  /** Open API (all markets). */
  openApi: "https://open-api.tiktokglobalshop.com",
} as const;

/** API versions, centralized so a TikTok version bump is a one-line change.
 *  The version is part of the signed path, so it must match the API reference
 *  exactly. */
export const TIKTOK_API = {
  tokenGetPath: "/api/v2/token/get",
  tokenRefreshPath: "/api/v2/token/refresh",
  authorizedShopsPath: "/authorization/202309/shops",
  orderSearchPath: "/order/202309/orders/search",
  orderDetailPath: "/order/202507/orders",
} as const;

/** Access tokens last ~7 days; refresh when fewer than this many seconds remain. */
export const REFRESH_WINDOW_SECONDS = 24 * 60 * 60;

/** TikTok rejects timestamps outside roughly now-5min .. now+30s. */
export const TIMESTAMP_TOLERANCE_NOTE = "timestamp is 10-digit unix seconds";

export const HTTP_TIMEOUT_MS = 15_000;

/** The callback requires a server-issued single-use `state` in prod/preview.
 *  In dev it is optional because Partner Center's sandbox "Authorize app"
 *  button starts the flow itself (no state from us). */
export function callbackRequiresState(env: TikTokEnv = TIKTOK_ENV): boolean {
  if (process.env.TIKTOK_REQUIRE_STATE === "true") return true;
  if (process.env.TIKTOK_REQUIRE_STATE === "false" && env === "dev") return false;
  return env !== "dev";
}

export interface AppCredentials {
  appKey: string;
  appSecret: string;
}

/** Reads the app key/secret from the server environment. Throws a message that
 *  names the missing variable but never echoes a value. */
export function requireAppCredentials(env: EnvLike = process.env): AppCredentials {
  const appKey = env.TIKTOK_APP_KEY?.trim();
  const appSecret = env.TIKTOK_APP_SECRET?.trim();
  if (!appKey) throw new Error("TIKTOK_APP_KEY is not set.");
  if (!appSecret) throw new Error("TIKTOK_APP_SECRET is not set.");
  return { appKey, appSecret };
}
