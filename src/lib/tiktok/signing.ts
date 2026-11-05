import { createHmac, timingSafeEqual } from "node:crypto";

// TikTok Shop request signing (HMAC-SHA256), per
// https://partner.tiktokshop.com/docv2/page/sign-your-api-request
//
//   1. take every query parameter EXCEPT `sign` and `access_token`
//   2. sort keys alphabetically, concatenate `{key}{value}`
//   3. prepend the request PATH (no host, no query string)
//   4. append the raw request body (unless multipart/form-data)
//   5. wrap with the app secret on both ends
//   6. HMAC-SHA256 keyed with the app secret → lowercase hex
//
// The access token goes in the `x-tts-access-token` header for 202309+ APIs and
// is never part of the signature.

const EXCLUDED_KEYS = new Set(["sign", "access_token"]);

export function computeSignature(opts: {
  path: string;
  query: Record<string, string | number | undefined>;
  /** Exact bytes sent as the body ("" when there is none). */
  body?: string;
  appSecret: string;
}): string {
  const { path, query, body = "", appSecret } = opts;
  const joined = Object.keys(query)
    .filter((k) => !EXCLUDED_KEYS.has(k) && query[k] !== undefined)
    .sort()
    .map((k) => `${k}${query[k]}`)
    .join("");
  const toSign = `${appSecret}${path}${joined}${body}${appSecret}`;
  return createHmac("sha256", appSecret).update(toSign).digest("hex");
}

/** TikTok webhook signature: HMAC-SHA256(app_key + rawBody, app_secret), hex.
 *  Not used by Milestone 1 (webhooks are a later milestone) but kept here with
 *  the other signature code so it's unit-tested alongside it. */
export function computeWebhookSignature(appKey: string, rawBody: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(appKey + rawBody).digest("hex");
}

/** Constant-time comparison of two hex signatures. */
export function signaturesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
