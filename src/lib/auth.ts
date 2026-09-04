// Shared-passcode site gate.
//
// This is deliberately simple: one 4-digit code shared by everyone who
// should have access (matches how the business actually works — no
// per-person accounts), verified here and in src/proxy.ts. Uses Web
// Crypto (`crypto.subtle`) rather than Node's `crypto` module so the same
// code works whether this runs under the Node or Edge runtime.

export const AUTH_COOKIE_NAME = "amoruh_auth";

const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The cookie value a successful login sets — a fixed hash derived from
 *  server-only secrets, not from anything guessable client-side, and not
 *  the passcode itself (so the cookie never leaks the code even if read). */
export async function computeAuthToken(): Promise<string | null> {
  const passcode = process.env.SITE_PASSCODE;
  const secret = process.env.AUTH_COOKIE_SECRET;
  if (!passcode || !secret) return null;
  return sha256Hex(`${passcode}:${secret}`);
}

export function verifyPasscode(input: string): boolean {
  const passcode = process.env.SITE_PASSCODE;
  return Boolean(passcode) && input.trim() === passcode;
}

export async function verifyAuthToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const expected = await computeAuthToken();
  return Boolean(expected) && token === expected;
}
