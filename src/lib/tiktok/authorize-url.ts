import { randomBytes } from "node:crypto";
import type { EnvLike } from "./config";

// Builds the seller-authorization link for the Custom app. The seller opens it,
// signs in to Seller Center and approves; TikTok then redirects to the app's
// registered Redirect URL with `code` (and our `state`, echoed back).
//
// The US marketplace uses a different authorization host from the rest of the
// world — see TikTok's "Create your App" doc. Do not mix the two. Override only
// with TIKTOK_AUTHORIZE_BASE if Partner Center shows a different link.

export const US_AUTHORIZE_BASE = "https://services.us.tiktokshop.com/open/authorize";

/** Fresh, unguessable, single-use OAuth state (256 bits). */
export function newOauthState(): string {
  return randomBytes(32).toString("hex");
}

/** `service_id` is a public identifier shown on the app page (NOT the app secret). */
export function buildAuthorizeUrl(state: string, env: EnvLike = process.env): string {
  const serviceId = env.TIKTOK_SERVICE_ID?.trim();
  if (!serviceId) throw new Error("TIKTOK_SERVICE_ID is not set.");
  const base = env.TIKTOK_AUTHORIZE_BASE?.trim() || US_AUTHORIZE_BASE;
  const url = new URL(base);
  if (url.protocol !== "https:") throw new Error("TIKTOK_AUTHORIZE_BASE must be https.");
  url.searchParams.set("service_id", serviceId);
  url.searchParams.set("state", state);
  return url.toString();
}
