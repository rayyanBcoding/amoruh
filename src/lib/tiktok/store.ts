import { Redis } from "@upstash/redis";
import { redis as appRedis } from "../kv";
import { TIKTOK_ENV, tiktokKey, type TikTokEnv } from "./config";

// Redis access for the TikTok integration. By default it shares the app's Redis
// but ONLY ever touches keys under `amoruh:tiktok:{env}:`, so dev / preview / prod
// cannot overwrite each other. Setting TIKTOK_REDIS_URL + TIKTOK_REDIS_TOKEN
// moves just the TikTok data to a dedicated database with no other code change.

declare global {
  var __amoruhTiktokRedis: Redis | undefined;
}

export function tiktokRedis(): Redis {
  if (globalThis.__amoruhTiktokRedis) return globalThis.__amoruhTiktokRedis;
  const url = process.env.TIKTOK_REDIS_URL?.trim();
  const token = process.env.TIKTOK_REDIS_TOKEN?.trim();
  globalThis.__amoruhTiktokRedis = url && token ? new Redis({ url, token }) : appRedis;
  return globalThis.__amoruhTiktokRedis;
}

export interface StoredShop {
  /** TikTok shop ID — a STRING (large integer). */
  id: string;
  name: string;
  region: string;
  sellerType: string;
  /** Opaque value TikTok requires on most shop-scoped calls. Treated as sensitive. */
  cipher: string;
  code: string;
}

export type ConnectionStatus = "connected" | "needs_reauthorization";

export interface TikTokConnection {
  status: ConnectionStatus;
  env: TikTokEnv;
  openId: string;
  sellerName: string;
  sellerBaseRegion: string;
  userType: number | null;
  grantedScopes: string[];
  /** Encrypted (AES-256-GCM) — see crypto.ts. Never returned by any route. */
  accessTokenEnc: string;
  accessExpiresAt: number; // unix seconds
  refreshTokenEnc: string;
  refreshExpiresAt: number; // unix seconds
  shops: StoredShop[];
  connectedAt: string;
  updatedAt: string;
}

export const connectionKey = (env: TikTokEnv = TIKTOK_ENV) => tiktokKey("connection", env);
export const oauthStateKey = (state: string) => tiktokKey(`oauth_state:${state}`);
export const refreshLockKey = () => tiktokKey("token_lock");

export async function loadConnection(): Promise<TikTokConnection | null> {
  return (await tiktokRedis().get<TikTokConnection>(connectionKey())) ?? null;
}

export async function saveConnection(conn: TikTokConnection): Promise<void> {
  await tiktokRedis().set(connectionKey(), conn);
}

/** Single-use OAuth `state`: stored for 10 minutes, consumed atomically on return. */
export async function saveOauthState(state: string): Promise<void> {
  await tiktokRedis().set(oauthStateKey(state), "1", { ex: 600 });
}

export async function consumeOauthState(state: string): Promise<boolean> {
  const v = await tiktokRedis().getdel(oauthStateKey(state));
  return v !== null && v !== undefined;
}

/** What routes may expose: booleans, timestamps, shop identity. NEVER tokens or ciphers. */
export function publicStatus(conn: TikTokConnection | null) {
  if (!conn) return { env: TIKTOK_ENV, connected: false as const };
  const now = Math.floor(Date.now() / 1000);
  return {
    env: conn.env,
    connected: conn.status === "connected",
    status: conn.status,
    sellerName: conn.sellerName,
    sellerBaseRegion: conn.sellerBaseRegion,
    grantedScopes: conn.grantedScopes,
    shops: conn.shops.map((s) => ({ id: s.id, name: s.name, region: s.region, sellerType: s.sellerType, code: s.code })),
    accessTokenValid: conn.accessExpiresAt > now,
    accessExpiresAt: new Date(conn.accessExpiresAt * 1000).toISOString(),
    refreshExpiresAt: new Date(conn.refreshExpiresAt * 1000).toISOString(),
    connectedAt: conn.connectedAt,
    updatedAt: conn.updatedAt,
  };
}
