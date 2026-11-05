import { HTTP_TIMEOUT_MS, TIKTOK_API, TIKTOK_HOSTS, requireAppCredentials, type AppCredentials } from "./config";
import { ReadOnlyViolationError, TikTokApiError, isRetryable } from "./errors";
import { parseJsonPreservingIds } from "./json";
import { computeSignature } from "./signing";

// The ONLY door to TikTok. Phase 1 is read-only: every outgoing Open API call is
// checked against this allow-list BEFORE a network request is made, so a coding
// mistake cannot write to TikTok (no product / inventory / order / fulfillment /
// webhook-config changes). Note Order Search is a POST that only READS.
const READ_ONLY_ALLOW_LIST: ReadonlyArray<{ method: "GET" | "POST"; path: string }> = [
  { method: "GET", path: TIKTOK_API.authorizedShopsPath },
  { method: "POST", path: TIKTOK_API.orderSearchPath },
  { method: "GET", path: TIKTOK_API.orderDetailPath },
];

export function assertReadOnly(method: string, path: string): void {
  if (!READ_ONLY_ALLOW_LIST.some((op) => op.method === method && op.path === path)) {
    throw new ReadOnlyViolationError(method, path);
  }
}

export type FetchLike = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface ClientDeps {
  fetchImpl?: FetchLike;
  credentials?: AppCredentials;
  now?: () => number; // ms
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

interface Envelope<T> {
  code?: number;
  message?: string;
  request_id?: string;
  data?: T;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function sendOnce<T>(url: string, init: Parameters<FetchLike>[1], fetchImpl: FetchLike): Promise<{ data: T; requestId: string | null }> {
  let res: Awaited<ReturnType<FetchLike>>;
  let text: string;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    text = await res.text();
  } catch {
    // Never include the URL (it may carry the app secret) or the underlying message.
    throw new TikTokApiError("Network error or timeout talking to TikTok.");
  }
  let envelope: Envelope<T>;
  try {
    envelope = parseJsonPreservingIds<Envelope<T>>(text);
  } catch {
    throw new TikTokApiError("TikTok returned a non-JSON response.", { httpStatus: res.status });
  }
  const requestId = envelope.request_id ?? null;
  if (res.status >= 400 || (envelope.code !== undefined && envelope.code !== 0)) {
    throw new TikTokApiError(envelope.message || "TikTok API error.", { code: envelope.code ?? null, requestId, httpStatus: res.status });
  }
  if (envelope.data === undefined) {
    throw new TikTokApiError("TikTok response had no data field.", { code: envelope.code ?? null, requestId, httpStatus: res.status });
  }
  return { data: envelope.data, requestId };
}

async function withRetry<T>(fn: () => Promise<T>, deps: ClientDeps): Promise<T> {
  const max = deps.maxRetries ?? 2;
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= max || !isRetryable(err)) throw err;
      await sleep(400 * 2 ** attempt + Math.floor(Math.random() * 200)); // backoff + jitter
    }
  }
}

export interface TokenPayload {
  access_token: string;
  access_token_expire_in: number;
  refresh_token: string;
  refresh_token_expire_in: number;
  open_id?: string;
  seller_name?: string;
  seller_base_region?: string;
  user_type?: number;
  granted_scopes?: string[];
}

/** Exchanges the one-time auth_code for tokens. `grant_type=authorized_code` is
 *  intentional (TikTok's value, not the OAuth-standard `authorization_code`). */
export async function exchangeAuthCode(authCode: string, deps: ClientDeps = {}): Promise<TokenPayload> {
  const { appKey, appSecret } = deps.credentials ?? requireAppCredentials();
  const q = new URLSearchParams({ app_key: appKey, app_secret: appSecret, auth_code: authCode, grant_type: "authorized_code" });
  const url = `${TIKTOK_HOSTS.auth}${TIKTOK_API.tokenGetPath}?${q}`;
  // Not retried: an auth_code is single-use.
  const { data } = await sendOnce<TokenPayload>(url, { method: "GET" }, deps.fetchImpl ?? defaultFetch);
  return data;
}

export async function refreshAccessToken(refreshToken: string, deps: ClientDeps = {}): Promise<TokenPayload> {
  const { appKey, appSecret } = deps.credentials ?? requireAppCredentials();
  const q = new URLSearchParams({ app_key: appKey, app_secret: appSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  const url = `${TIKTOK_HOSTS.auth}${TIKTOK_API.tokenRefreshPath}?${q}`;
  const { data } = await sendOnce<TokenPayload>(url, { method: "GET" }, deps.fetchImpl ?? defaultFetch);
  return data;
}

export interface ApiCall {
  method: "GET" | "POST";
  path: string;
  accessToken: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

/** Signed, allow-listed Open API request. Returns TikTok's `data` plus request_id. */
export async function callOpenApi<T>(call: ApiCall, deps: ClientDeps = {}): Promise<{ data: T; requestId: string | null }> {
  assertReadOnly(call.method, call.path);
  const { appKey, appSecret } = deps.credentials ?? requireAppCredentials();

  return withRetry(async () => {
    const nowMs = (deps.now ?? Date.now)(); // fresh timestamp on every attempt
    const query: Record<string, string | number | undefined> = {
      ...call.query,
      app_key: appKey,
      timestamp: Math.floor(nowMs / 1000), // 10-digit seconds
    };
    const body = call.body === undefined ? "" : JSON.stringify(call.body);
    const sign = computeSignature({ path: call.path, query, body, appSecret });
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    qs.set("sign", sign);
    const url = `${TIKTOK_HOSTS.openApi}${call.path}?${qs}`;
    return sendOnce<T>(
      url,
      {
        method: call.method,
        headers: { "content-type": "application/json", "x-tts-access-token": call.accessToken },
        body: call.method === "POST" ? body : undefined,
      },
      deps.fetchImpl ?? defaultFetch
    );
  }, deps);
}
