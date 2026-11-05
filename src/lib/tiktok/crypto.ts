import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Token encryption at rest. AES-256-GCM, fresh random 96-bit IV per record.
//
// The key comes ONLY from the server environment (TIKTOK_TOKEN_ENCRYPTION_KEY,
// 32 random bytes, base64). It is never stored in Redis, Git, logs or client
// code. Dev and prod use DIFFERENT keys, so a dev process that can read the
// shared Redis still cannot decrypt production tokens.
//
// AAD (additional authenticated data) binds each ciphertext to its context
// ("env|openId|tokenType"), so a ciphertext copied to another environment,
// seller or token slot fails authentication instead of decrypting.
//
// Stored format: "v1.<iv b64>.<tag b64>.<ciphertext b64>".

const VERSION = "v1";

function loadKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.TIKTOK_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("TIKTOK_TOKEN_ENCRYPTION_KEY is not set.");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TIKTOK_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

export function encryptSecret(plaintext: string, aad: string, env?: Record<string, string | undefined>): string {
  const key = loadKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

export function decryptSecret(blob: string, aad: string, env?: Record<string, string | undefined>): string {
  const key = loadKey(env);
  const parts = blob.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Unrecognized encrypted token format.");
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // Deliberately generic: never reveal why (wrong key vs tampered vs wrong AAD).
    throw new Error("Could not decrypt the stored TikTok token (wrong key, environment or tampered data).");
  }
}

/** `subjectId` is the authorizing seller's `open_id` from the token response —
 *  known the moment tokens are issued, before any shop lookup is possible. */
export function tokenAad(env: string, subjectId: string, tokenType: "access" | "refresh"): string {
  return `${env}|${subjectId}|${tokenType}`;
}
