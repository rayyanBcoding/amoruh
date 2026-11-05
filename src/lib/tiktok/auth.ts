import { exchangeAuthCode, refreshAccessToken, type ClientDeps, type TokenPayload } from "./client";
import { REFRESH_WINDOW_SECONDS, TIKTOK_ENV } from "./config";
import { decryptSecret, encryptSecret, tokenAad } from "./crypto";
import { TikTokApiError } from "./errors";
import { getAuthorizedShops } from "./shops";
import { loadConnection, refreshLockKey, saveConnection, tiktokRedis, type TikTokConnection } from "./store";

const nowSec = () => Math.floor(Date.now() / 1000);

function encryptTokens(t: TokenPayload, openId: string) {
  return {
    accessTokenEnc: encryptSecret(t.access_token, tokenAad(TIKTOK_ENV, openId, "access")),
    refreshTokenEnc: encryptSecret(t.refresh_token, tokenAad(TIKTOK_ENV, openId, "refresh")),
    accessExpiresAt: t.access_token_expire_in,
    refreshExpiresAt: t.refresh_token_expire_in,
  };
}

/** OAuth callback core: exchange the one-time code, encrypt + store the tokens,
 *  then look up the authorized shop(s) with the fresh token. Returns the stored
 *  connection (the caller must only expose `publicStatus(...)` of it). */
export async function connectWithAuthCode(authCode: string, deps: ClientDeps = {}): Promise<TikTokConnection> {
  const t = await exchangeAuthCode(authCode, deps);
  if (!t.access_token || !t.refresh_token) throw new TikTokApiError("TikTok token response was missing tokens.");
  const openId = t.open_id ?? "unknown";
  const stamp = new Date().toISOString();

  // Persist tokens FIRST so a failure in the shop lookup never loses the (single-use) grant.
  let conn: TikTokConnection = {
    status: "connected",
    env: TIKTOK_ENV,
    openId,
    sellerName: t.seller_name ?? "",
    sellerBaseRegion: t.seller_base_region ?? "",
    userType: typeof t.user_type === "number" ? t.user_type : null,
    grantedScopes: t.granted_scopes ?? [],
    ...encryptTokens(t, openId),
    shops: [],
    connectedAt: stamp,
    updatedAt: stamp,
  };
  await saveConnection(conn);

  const { shops } = await getAuthorizedShops(t.access_token, deps);
  conn = { ...conn, shops, updatedAt: new Date().toISOString() };
  await saveConnection(conn);
  return conn;
}

/** Returns a usable access token, refreshing it (single-flight) when it is within
 *  the refresh window. The refresh token TikTok returns is ALWAYS persisted. */
export async function getValidAccessToken(deps: ClientDeps = {}): Promise<{ accessToken: string; conn: TikTokConnection }> {
  let conn = await loadConnection();
  if (!conn) throw new TikTokApiError("No TikTok connection for this environment — authorize the app first.");
  if (conn.status !== "connected") throw new TikTokApiError("TikTok connection needs re-authorization.");

  if (conn.accessExpiresAt - nowSec() > REFRESH_WINDOW_SECONDS) {
    return { accessToken: decryptSecret(conn.accessTokenEnc, tokenAad(conn.env, conn.openId, "access")), conn };
  }

  const redis = tiktokRedis();
  const gotLock = await redis.set(refreshLockKey(), "1", { nx: true, ex: 30 });
  if (!gotLock) {
    // Another process is refreshing: wait briefly, then re-read what it stored.
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const fresh = await loadConnection();
      if (fresh && fresh.accessExpiresAt - nowSec() > 60) {
        return { accessToken: decryptSecret(fresh.accessTokenEnc, tokenAad(fresh.env, fresh.openId, "access")), conn: fresh };
      }
    }
    throw new TikTokApiError("Timed out waiting for another token refresh.");
  }

  try {
    const refreshToken = decryptSecret(conn.refreshTokenEnc, tokenAad(conn.env, conn.openId, "refresh"));
    let t: TokenPayload;
    try {
      t = await refreshAccessToken(refreshToken, deps);
    } catch (err) {
      // Only a definitive TikTok rejection (not a timeout / 5xx / throttle) means the grant is dead.
      if (err instanceof TikTokApiError && err.code !== null && err.code !== 36009002 && (err.httpStatus ?? 0) < 500 && err.httpStatus !== 429) {
        await saveConnection({ ...conn, status: "needs_reauthorization", updatedAt: new Date().toISOString() });
      }
      throw err;
    }
    conn = { ...conn, ...encryptTokens(t, conn.openId), updatedAt: new Date().toISOString() };
    await saveConnection(conn);
    return { accessToken: t.access_token, conn };
  } finally {
    await redis.del(refreshLockKey());
  }
}
