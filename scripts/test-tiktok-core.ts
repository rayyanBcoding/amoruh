// TikTok Shop integration core — signing, token encryption, big-ID handling,
// read-only guard, signed client, sanitizer, token storage/refresh flow.
// Fully offline (mock fetch + in-memory Redis); touches no real service.
//   npx tsx scripts/test-tiktok-core.ts
import { createHmac, randomBytes } from "node:crypto";

// Env must be set BEFORE the modules under test are imported.
process.env.AMORUH_REDIS_URL = "https://example.invalid";
process.env.AMORUH_REDIS_TOKEN = "x";
delete process.env.VERCEL_ENV;
delete process.env.TIKTOK_REDIS_URL;
process.env.TIKTOK_APP_KEY = "testappkey123";
process.env.TIKTOK_APP_SECRET = "test-app-secret-value";
process.env.TIKTOK_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.log(`FAIL: ${label}\n   expected ${JSON.stringify(expected)}\n   got      ${JSON.stringify(actual)}`);
  }
}
const ok = (label: string, cond: boolean) => check(label, cond, true);
async function throwsAsync(label: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    fail++;
    console.log(`FAIL: ${label} (did not throw)`);
  } catch (e) {
    if (match && !match.test(String(e instanceof Error ? e.message : e))) {
      fail++;
      console.log(`FAIL: ${label} (wrong error: ${e instanceof Error ? e.message : e})`);
    } else pass++;
  }
}
function throwsSync(label: string, fn: () => unknown, match?: RegExp) {
  try {
    fn();
    fail++;
    console.log(`FAIL: ${label} (did not throw)`);
  } catch (e) {
    if (match && !match.test(String(e instanceof Error ? e.message : e))) {
      fail++;
      console.log(`FAIL: ${label} (wrong error)`);
    } else pass++;
  }
}

// ---- minimal in-memory Redis (get / set with nx+ex / getdel / del) ----
class MemRedis {
  m = new Map<string, unknown>();
  async get<T>(k: string): Promise<T | null> {
    return (this.m.has(k) ? JSON.parse(JSON.stringify(this.m.get(k))) : null) as T | null;
  }
  async set(k: string, v: unknown, opts?: { nx?: boolean; ex?: number }) {
    if (opts?.nx && this.m.has(k)) return null;
    this.m.set(k, JSON.parse(JSON.stringify(v)));
    return "OK";
  }
  async getdel(k: string) {
    const v = this.m.get(k) ?? null;
    this.m.delete(k);
    return v;
  }
  async del(k: string) {
    return this.m.delete(k) ? 1 : 0;
  }
  writes = 0;
  async mget<T>(...keys: string[]): Promise<(T | null)[]> {
    return Promise.all(keys.map((k) => this.get<T>(k)));
  }
  pipeline() {
    const ops: (() => Promise<unknown>)[] = [];
    const p = {
      set: (k: string, v: unknown) => { ops.push(async () => { this.writes++; return this.set(k, v); }); return p; },
      del: (k: string) => { ops.push(async () => this.del(k)); return p; },
      exec: async () => { const out: unknown[] = []; for (const op of ops) out.push(await op()); return out; },
    };
    return p;
  }
}
const mem = new MemRedis();
(globalThis as { __amoruhTiktokRedis?: unknown }).__amoruhTiktokRedis = mem;

async function main() {
  const { computeSignature, computeWebhookSignature, signaturesMatch } = await import("../src/lib/tiktok/signing");
  const { encryptSecret, decryptSecret, tokenAad } = await import("../src/lib/tiktok/crypto");
  const { parseJsonPreservingIds, quoteLargeIntegers } = await import("../src/lib/tiktok/json");
  const { assertReadOnly, callOpenApi } = await import("../src/lib/tiktok/client");
  const { TIKTOK_API, resolveTikTokEnv, tiktokKey, callbackRequiresState } = await import("../src/lib/tiktok/config");
  const { sanitize, keyPaths } = await import("../src/lib/tiktok/sanitize");
  const { ReadOnlyViolationError, TikTokApiError } = await import("../src/lib/tiktok/errors");
  const { connectWithAuthCode, getValidAccessToken } = await import("../src/lib/tiktok/auth");
  const { loadConnection, publicStatus, consumeOauthState, saveOauthState } = await import("../src/lib/tiktok/store");

  // ---------- environment resolution ----------
  check("no VERCEL_ENV (laptop) → dev", resolveTikTokEnv({}), "dev");
  check("VERCEL_ENV=production → prod", resolveTikTokEnv({ VERCEL_ENV: "production" }), "prod");
  check("VERCEL_ENV=preview → preview", resolveTikTokEnv({ VERCEL_ENV: "preview" }), "preview");
  check("TIKTOK_ENV can NOT select prod from a laptop", resolveTikTokEnv({ TIKTOK_ENV: "prod" }), "dev");
  check("keys are namespaced per env", [tiktokKey("connection", "dev"), tiktokKey("connection", "prod")], ["amoruh:tiktok:dev:connection", "amoruh:tiktok:prod:connection"]);
  ok("dev: state check optional", callbackRequiresState("dev") === false);
  ok("prod: state check mandatory", callbackRequiresState("prod") === true);
  ok("preview: state check mandatory", callbackRequiresState("preview") === true);

  // ---------- signing (independent re-implementation of the documented algorithm) ----------
  const secret = "s3cret";
  const docSign = (path: string, q: Record<string, string>, body: string) => {
    const s = Object.keys(q).filter((k) => k !== "sign" && k !== "access_token").sort().map((k) => k + q[k]).join("");
    return createHmac("sha256", secret).update(secret + path + s + body + secret).digest("hex");
  };
  const q = { timestamp: "1700000000", app_key: "ak", shop_cipher: "CIPHER", page_size: "10" };
  check("GET signature matches documented algorithm", computeSignature({ path: "/order/202507/orders", query: q, appSecret: secret }), docSign("/order/202507/orders", q, ""));
  check("POST body is part of the signature", computeSignature({ path: "/p", query: q, body: '{"a":1}', appSecret: secret }), docSign("/p", q, '{"a":1}'));
  ok("body changes the signature", computeSignature({ path: "/p", query: q, body: '{"a":1}', appSecret: secret }) !== computeSignature({ path: "/p", query: q, body: '{"a":2}', appSecret: secret }));
  check("sign + access_token are excluded", computeSignature({ path: "/p", query: { ...q, sign: "zzz", access_token: "tok" }, appSecret: secret }), computeSignature({ path: "/p", query: q, appSecret: secret }));
  check("key order does not matter (sorted)", computeSignature({ path: "/p", query: { b: "2", a: "1" }, appSecret: secret }), computeSignature({ path: "/p", query: { a: "1", b: "2" }, appSecret: secret }));
  ok("path is part of the signature", computeSignature({ path: "/a", query: q, appSecret: secret }) !== computeSignature({ path: "/b", query: q, appSecret: secret }));
  ok("signature is 64 lowercase hex", /^[0-9a-f]{64}$/.test(computeSignature({ path: "/p", query: q, appSecret: secret })));
  const wh = computeWebhookSignature("ak", '{"x":1}', secret);
  check("webhook signature = HMAC(app_key+body, secret)", wh, createHmac("sha256", secret).update('ak{"x":1}').digest("hex"));
  ok("signaturesMatch true/false", signaturesMatch(wh, wh) && !signaturesMatch(wh, wh.slice(1) + "0") && !signaturesMatch(wh, "short"));

  // ---------- encryption ----------
  const aad = tokenAad("dev", "open123", "access");
  const blob = encryptSecret("TTP_access_token_value", aad);
  ok("ciphertext does not contain the plaintext", !blob.includes("TTP_access_token_value"));
  check("round-trips", decryptSecret(blob, aad), "TTP_access_token_value");
  ok("fresh IV every time", encryptSecret("x", aad) !== encryptSecret("x", aad));
  throwsSync("wrong environment (AAD) cannot decrypt", () => decryptSecret(blob, tokenAad("prod", "open123", "access")), /Could not decrypt/);
  throwsSync("wrong token slot cannot decrypt", () => decryptSecret(blob, tokenAad("dev", "open123", "refresh")), /Could not decrypt/);
  throwsSync("wrong seller cannot decrypt", () => decryptSecret(blob, tokenAad("dev", "other", "access")), /Could not decrypt/);
  const parts = blob.split(".");
  parts[3] = Buffer.from("tampered!!!!!!!!!!!!!!").toString("base64");
  throwsSync("tampered ciphertext is rejected", () => decryptSecret(parts.join("."), aad), /Could not decrypt/);
  throwsSync("a DIFFERENT key (e.g. dev vs prod) cannot decrypt", () => decryptSecret(blob, aad, { TIKTOK_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") }), /Could not decrypt/);
  throwsSync("missing key fails loudly", () => encryptSecret("x", aad, {}), /TIKTOK_TOKEN_ENCRYPTION_KEY is not set/);
  throwsSync("short key rejected", () => encryptSecret("x", aad, { TIKTOK_TOKEN_ENCRYPTION_KEY: Buffer.from("short").toString("base64") }), /32 bytes/);
  throwsSync("garbage format rejected", () => decryptSecret("nope", aad), /format/);

  // ---------- big IDs ----------
  const raw = '{"id":7704086551785473805,"s":"7704086551785473805","small":123,"f":1.5,"arr":[7495021198086669456,1],"txt":"a 1234567890123456789 b"}';
  const parsed = parseJsonPreservingIds<Record<string, unknown>>(raw);
  check("unquoted 19-digit id becomes an exact STRING", parsed.id, "7704086551785473805");
  check("already-string id untouched", parsed.s, "7704086551785473805");
  check("small ints stay numbers", parsed.small, 123);
  check("floats untouched", parsed.f, 1.5);
  check("ids inside arrays become strings", parsed.arr, ["7495021198086669456", 1]);
  check("digits inside string text untouched", parsed.txt, "a 1234567890123456789 b");
  ok("naive JSON.parse would have corrupted it (proves the need)", String(JSON.parse(raw).id) !== "7704086551785473805");
  ok("quoteLargeIntegers leaves valid JSON", (() => { try { JSON.parse(quoteLargeIntegers(raw)); return true; } catch { return false; } })());

  // ---------- read-only guard ----------
  assertReadOnly("GET", TIKTOK_API.authorizedShopsPath);
  assertReadOnly("POST", TIKTOK_API.orderSearchPath);
  assertReadOnly("GET", TIKTOK_API.orderDetailPath);
  pass += 3;
  for (const [m, p] of [
    ["PUT", "/event/202309/webhooks"], ["DELETE", "/event/202309/webhooks"], ["POST", "/fulfillment/202309/orders/1/packages"],
    ["POST", "/product/202309/products"], ["PUT", "/product/202309/inventory/update"], ["POST", "/order/202309/orders/1/cancel"],
    ["GET", TIKTOK_API.orderSearchPath], ["POST", TIKTOK_API.orderDetailPath], ["POST", TIKTOK_API.authorizedShopsPath],
  ] as const) {
    throwsSync(`blocked: ${m} ${p}`, () => assertReadOnly(m, p), /Blocked/);
  }
  let calls = 0;
  const countingFetch = async () => { calls++; return { status: 200, text: async () => "{}" }; };
  await throwsAsync("callOpenApi refuses a write BEFORE any network call", () => callOpenApi({ method: "POST", path: "/product/202309/products", accessToken: "t", body: {} }, { fetchImpl: countingFetch }), /Blocked/);
  check("…and the network was never touched", calls, 0);
  ok("ReadOnlyViolationError type", new ReadOnlyViolationError("POST", "/x") instanceof Error);

  // ---------- signed client (mock fetch) ----------
  const creds = { appKey: "ak", appSecret: secret };
  let seen: { url: string; init: { method: string; headers?: Record<string, string>; body?: string } } | null = null;
  const okFetch = async (url: string, init: { method: string; headers?: Record<string, string>; body?: string }) => {
    seen = { url, init };
    return { status: 200, text: async () => '{"code":0,"message":"success","request_id":"REQ1","data":{"orders":[{"id":7704086551785473805}]}}' };
  };
  const res = await callOpenApi<{ orders: { id: string }[] }>(
    { method: "POST", path: TIKTOK_API.orderSearchPath, accessToken: "ACCESS_TOKEN_VALUE", query: { shop_cipher: "C/ipher+=", page_size: 5 }, body: {} },
    { fetchImpl: okFetch, credentials: creds, now: () => 1_700_000_123_456 }
  );
  const u = new URL(seen!.url);
  check("host", u.origin, "https://open-api.tiktokglobalshop.com");
  check("path", u.pathname, TIKTOK_API.orderSearchPath);
  check("app_key param", u.searchParams.get("app_key"), "ak");
  check("timestamp is 10-digit seconds", u.searchParams.get("timestamp"), "1700000123");
  check("shop_cipher decodes back exactly", u.searchParams.get("shop_cipher"), "C/ipher+=");
  ok("access token is NOT in the URL", !seen!.url.includes("ACCESS_TOKEN_VALUE"));
  check("access token sent in x-tts-access-token header", seen!.init.headers?.["x-tts-access-token"], "ACCESS_TOKEN_VALUE");
  check("content-type json", seen!.init.headers?.["content-type"], "application/json");
  const sentQuery: Record<string, string> = {};
  u.searchParams.forEach((v, k) => { if (k !== "sign") sentQuery[k] = v; });
  check("sign matches an independent recomputation", u.searchParams.get("sign"), docSign(TIKTOK_API.orderSearchPath, sentQuery, "{}"));
  check("large order id returned as exact string", res.data.orders[0].id, "7704086551785473805");
  check("request_id surfaced", res.requestId, "REQ1");

  const errFetch = async () => ({ status: 200, text: async () => '{"code":36004004,"message":"Invalid access token","request_id":"R2"}' });
  try {
    await callOpenApi({ method: "GET", path: TIKTOK_API.authorizedShopsPath, accessToken: "t" }, { fetchImpl: errFetch, credentials: creds });
    fail++; console.log("FAIL: non-zero code should throw");
  } catch (e) {
    ok("non-zero code → TikTokApiError with code + request_id", e instanceof TikTokApiError && (e as InstanceType<typeof TikTokApiError>).code === 36004004 && (e as InstanceType<typeof TikTokApiError>).requestId === "R2");
    ok("error text never contains the token or secret", !String((e as Error).message).includes("secret") && !(e as InstanceType<typeof TikTokApiError>).describe().includes("t="));
  }
  let n = 0;
  const flaky = async () => (++n < 3 ? { status: 503, text: async () => '{"code":1,"message":"busy"}' } : { status: 200, text: async () => '{"code":0,"message":"success","data":{"shops":[]}}' });
  await callOpenApi({ method: "GET", path: TIKTOK_API.authorizedShopsPath, accessToken: "t" }, { fetchImpl: flaky, credentials: creds, sleep: async () => {} });
  check("retries 5xx then succeeds", n, 3);
  let n2 = 0;
  const denied = async () => { n2++; return { status: 200, text: async () => '{"code":36004004,"message":"bad"}' }; };
  await throwsAsync("auth-type errors are NOT retried", () => callOpenApi({ method: "GET", path: TIKTOK_API.authorizedShopsPath, accessToken: "t" }, { fetchImpl: denied, credentials: creds, sleep: async () => {} }));
  check("…exactly one attempt", n2, 1);
  const boom = async () => { throw new Error("connect ECONNREFUSED https://auth.tiktok-shops.com/...app_secret=LEAK"); };
  try {
    await callOpenApi({ method: "GET", path: TIKTOK_API.authorizedShopsPath, accessToken: "t" }, { fetchImpl: boom, credentials: creds, sleep: async () => {}, maxRetries: 0 });
  } catch (e) {
    ok("network error message does not leak the underlying URL/secret", !(e as Error).message.includes("LEAK"));
  }

  // ---------- sanitizer ----------
  const rawOrder = {
    id: "7704086551785473805", status: "AWAITING_SHIPMENT", create_time: 1700000000, update_time: 1700000100, order_type: "AUCTION", room_id: "7710000000000000001",
    auto_combine_group_id: "G1", buyer_email: "jane@example.com", buyer_message: "leave at door", user_id: "U1",
    recipient_address: { name: "Jane Doe", phone_number: "+15555550123", full_address: "1 Main St", postal_code: "20136" },
    payment: { currency: "USD", total_amount: "19.99", sub_total: "17.00", secret_internal: "zzz" },
    line_items: [
      { id: "L1", product_id: "7700000000000000009", sku_id: "7700000000000000010", seller_sku: "SKU-1", sale_price: "17.00", quantity: 1, product_name: "Light Blue", mystery: "unknown-value" },
      { id: "L2", product_id: "7700000000000000011", sku_id: "7700000000000000012", seller_sku: "SKU-2", sale_price: "2.00", quantity: 2, product_name: "Sample" },
      { id: "L3", product_id: "p3" },
    ],
    packages: [{ id: "PKG1" }], shop_cipher: "CIPHERVALUE", nickname_field: "x",
  };
  const clean = JSON.stringify(sanitize(rawOrder, "order"));
  for (const leak of ["jane@example.com", "leave at door", "Jane Doe", "+15555550123", "1 Main St", "20136", "CIPHERVALUE", "unknown-value", "zzz"]) {
    ok(`sanitized output never contains ${leak}`, !clean.includes(leak));
  }
  for (const keep of ["7704086551785473805", "AWAITING_SHIPMENT", "AUCTION", "7710000000000000001", "G1", "SKU-1", "7700000000000000009", "19.99", "Light Blue"]) {
    ok(`sanitized output keeps ${keep}`, clean.includes(keep));
  }
  const s = sanitize(rawOrder, "order") as Record<string, unknown>;
  check("recipient subtree fully redacted", s.recipient_address, "<redacted>");
  check("unknown scalar fails closed", ((s.line_items as { _shown: Record<string, unknown>[] })._shown[0]).mystery, "<hidden:string>");
  check("array truncated but length reported", (s.line_items as { _array_length: number })._array_length, 3);
  ok("only 2 array items shown", (s.line_items as { _shown: unknown[] })._shown.length === 2);
  const paths = keyPaths([rawOrder]);
  ok("key paths expose field NAMES for review", paths.some((p) => p.startsWith("[].line_items[].seller_sku")));
  ok("key paths never contain values", !paths.join("\n").includes("jane@example.com") && !paths.join("\n").includes("Jane Doe"));
  ok("redacted subtrees are listed without inner names", paths.some((p) => p.includes("recipient_address  <redacted subtree>")) && !paths.some((p) => p.includes("recipient_address.")));

  // ---------- connect + refresh flow ----------
  const NOW = Math.floor(Date.now() / 1000);
  const tokenResp = (access: string, refresh: string, accessExp: number) =>
    JSON.stringify({ code: 0, message: "success", request_id: "T1", data: { access_token: access, access_token_expire_in: accessExp, refresh_token: refresh, refresh_token_expire_in: NOW + 86400 * 90, open_id: "7010736057180325637", seller_name: "SANDBOX", seller_base_region: "US", user_type: 0, granted_scopes: ["seller.authorization.info", "seller.order.info"] } });
  const shopsResp = JSON.stringify({ code: 0, message: "success", request_id: "S1", data: { shops: [{ id: "7495021198086669456", name: "AMORUH Dev Shop", region: "US", seller_type: "LOCAL", cipher: "SHOPCIPHER_SECRET", code: "USUSLC7PEGLK" }] } });
  let tokenGets = 0;
  let tokenRefreshes = 0;
  let refreshFail = false;
  let lastRefreshToken = "";
  const flowFetch = async (url: string) => {
    if (url.includes("/api/v2/token/get")) { tokenGets++; return { status: 200, text: async () => tokenResp("ACCESS_1", "REFRESH_1", NOW + 3600) }; } // near expiry on purpose
    if (url.includes("/api/v2/token/refresh")) {
      tokenRefreshes++;
      lastRefreshToken = new URL(url).searchParams.get("refresh_token") ?? "";
      if (refreshFail) return { status: 200, text: async () => '{"code":105002,"message":"refresh token expired","request_id":"X"}' };
      return { status: 200, text: async () => tokenResp("ACCESS_2", "REFRESH_2", NOW + 86400 * 7) };
    }
    if (url.includes("/authorization/202309/shops")) return { status: 200, text: async () => shopsResp };
    throw new Error("unexpected url " + url);
  };
  const deps = { fetchImpl: flowFetch, credentials: creds, sleep: async () => {} };

  const conn = await connectWithAuthCode("AUTHCODE", deps);
  check("token exchange called once", tokenGets, 1);
  check("shop stored with string id", conn.shops[0].id, "7495021198086669456");
  const storedRaw = JSON.stringify(await mem.get("amoruh:tiktok:dev:connection"));
  ok("stored under the DEV namespace", storedRaw.length > 10);
  ok("no plaintext access token in Redis", !storedRaw.includes("ACCESS_1"));
  ok("no plaintext refresh token in Redis", !storedRaw.includes("REFRESH_1"));
  ok("no key material in Redis", !storedRaw.includes(process.env.TIKTOK_TOKEN_ENCRYPTION_KEY!));
  check("nothing written to other namespaces", [...mem.m.keys()].filter((k) => !k.startsWith("amoruh:tiktok:dev:")), []);
  const pub = JSON.stringify(publicStatus(await loadConnection()));
  for (const secretBit of ["ACCESS_1", "REFRESH_1", "SHOPCIPHER_SECRET", "accessTokenEnc", "refreshTokenEnc", "cipher"]) ok(`public status never exposes ${secretBit}`, !pub.includes(secretBit));
  ok("public status shows the shop", pub.includes("AMORUH Dev Shop") && pub.includes("7495021198086669456"));

  // access token is within the refresh window (1h < 24h) → refresh, and persist the NEW refresh token
  const t1 = await getValidAccessToken(deps);
  check("expiring token is refreshed", [tokenRefreshes, t1.accessToken], [1, "ACCESS_2"]);
  check("refresh used the stored refresh token (decrypted)", lastRefreshToken, "REFRESH_1");
  const t2 = await getValidAccessToken(deps);
  check("fresh token is reused, no second refresh", [tokenRefreshes, t2.accessToken], [1, "ACCESS_2"]);
  const afterRaw = JSON.stringify(await mem.get("amoruh:tiktok:dev:connection"));
  ok("rotated tokens are encrypted too", !afterRaw.includes("ACCESS_2") && !afterRaw.includes("REFRESH_2"));
  check("refresh lock released", mem.m.has("amoruh:tiktok:dev:token_lock"), false);

  // a prod-namespace record must never be read or overwritten from dev
  await mem.set("amoruh:tiktok:prod:connection", { marker: "PROD_UNTOUCHED" });
  await getValidAccessToken(deps);
  check("prod record untouched by dev activity", await mem.get("amoruh:tiktok:prod:connection"), { marker: "PROD_UNTOUCHED" });

  // refresh rejected by TikTok → needs_reauthorization, error surfaced, lock released
  const c = (await loadConnection())!;
  await mem.set("amoruh:tiktok:dev:connection", { ...c, accessExpiresAt: NOW + 10 });
  refreshFail = true;
  await throwsAsync("rejected refresh throws", () => getValidAccessToken(deps));
  check("connection flagged needs_reauthorization", (await loadConnection())!.status, "needs_reauthorization");
  check("lock released after failure", mem.m.has("amoruh:tiktok:dev:token_lock"), false);
  await throwsAsync("flagged connection refuses to run", () => getValidAccessToken(deps), /re-authorization/);

  // ---------- OAuth state: single use ----------
  await saveOauthState("abc");
  check("valid state consumed once", await consumeOauthState("abc"), true);
  check("…and cannot be replayed", await consumeOauthState("abc"), false);
  check("unknown state rejected", await consumeOauthState("nope"), false);

  // ---------- Authorize link ----------
  const { buildAuthorizeUrl, newOauthState, US_AUTHORIZE_BASE } = await import("../src/lib/tiktok/authorize-url");
  const s1 = newOauthState();
  const s2 = newOauthState();
  check("state is 64 hex chars", /^[0-9a-f]{64}$/.test(s1), true);
  check("states are unique", s1 !== s2, true);
  const authUrl = new URL(buildAuthorizeUrl(s1, { TIKTOK_SERVICE_ID: "svc123" }));
  check("authorize link uses the US host by default", `${authUrl.origin}${authUrl.pathname}`, US_AUTHORIZE_BASE);
  check("authorize link carries service_id", authUrl.searchParams.get("service_id"), "svc123");
  check("authorize link carries state", authUrl.searchParams.get("state"), s1);
  check("authorize link carries no secrets", [...authUrl.searchParams.keys()].sort().join(","), "service_id,state");
  let missing = "";
  try { buildAuthorizeUrl(s1, {}); } catch (e) { missing = (e as Error).message; }
  check("missing service id is a named error", missing, "TIKTOK_SERVICE_ID is not set.");
  let insecure = false;
  try { buildAuthorizeUrl(s1, { TIKTOK_SERVICE_ID: "x", TIKTOK_AUTHORIZE_BASE: "http://evil.example/open/authorize" }); } catch { insecure = true; }
  check("non-https authorize base rejected", insecure, true);

  // ---------- Auction validation sample: projection + analysis ----------
  const { projectOrder, analyzeAuctionRows } = await import("../src/lib/tiktok/auction-sample");
  const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const mk = (id: string, room: string | null, sku: string, over: Record<string, unknown> = {}, li: Record<string, unknown> = {}) => ({
    id, order_type: "AUCTION", status: "DELIVERED", create_time: T("2026-11-05T20:00:00Z"), paid_time: T("2026-11-05T20:00:05Z"),
    auto_combine_group_id: "9" + id, buyer_nickname: "SECRET-NICK", buyer_email: "secret@x.test", recipient_address: { name: "SECRET-NAME", full_address: "SECRET-ADDR" },
    user_id: "SECRET-UID", payment_method_name: "SECRET-CARD", packages: [{ id: "pk" + id }], shipping_provider: "USPS", tracking_number: "9400111899223344556677",
    line_items: [{ id: "li" + id, room_id: room, seller_sku: sku, sku_name: sku, sale_price: "31.50", currency: "USD", display_status: "DELIVERED", package_id: "pk" + id, ...li }], ...over,
  });
  const rowsFor = (orders: unknown[]) => orders.flatMap(projectOrder);

  const priv = rowsFor([mk("1", "R1", "5")]);
  const privJson = JSON.stringify(priv);
  ok("projection never carries buyer / recipient / user / card data", !/SECRET/.test(privJson));
  check("projection keeps ids as strings", [typeof priv[0].orderId, typeof priv[0].roomId, typeof priv[0].sellerSku], ["string", "string", "string"]);
  check("sale price stays a decimal string", priv[0].salePrice, "31.50");
  check("auction number parsed from seller_sku", priv[0].auctionNo, 5);
  check("tracking exposed only as last 4", priv[0].trackingLast4, "6677");
  ok("full tracking number is not in the projection", !privJson.includes("9400111899223344556677"));
  check("paid order", priv[0].paidState, "PAID");
  check("cancelled with no paid_time is UNPAID_CANCELLED", rowsFor([mk("2", "R1", "6", { status: "CANCELLED", paid_time: undefined })])[0].paidState, "UNPAID_CANCELLED");
  check("cancelled WITH paid_time is flagged separately", rowsFor([mk("3", "R1", "7", { status: "CANCELLED" })])[0].paidState, "CANCELLED_AFTER_PAID");
  check("order without id yields no rows", projectOrder({ line_items: [] }).length, 0);

  const newer = (n: number) => ({ create_time: T("2026-11-05T21:00:00Z") + n, paid_time: T("2026-11-05T21:00:05Z") + n });
  const older = (n: number) => ({ create_time: T("2026-10-20T21:00:00Z") + n, paid_time: T("2026-10-20T21:00:05Z") + n });
  const orders = [
    mk("a1", "ROOM_NEW", "1", newer(1), {}),
    mk("a2", "ROOM_NEW", "2", { ...newer(2), auto_combine_group_id: "G1" }),
    mk("a3", "ROOM_NEW", "3", { ...newer(3), auto_combine_group_id: "G1" }),
    mk("a5", "ROOM_NEW", "5", { ...newer(4), status: "CANCELLED", paid_time: undefined, cancel_reason: "Customer overdue to pay", cancellation_initiator: "SYSTEM" }),
    mk("a5b", "ROOM_NEW", "5", newer(5)), // duplicate auction number in the room
    mk("x1", "ROOM_NEW", "abc", newer(6)), // non-numeric sku
    mk("x2", null, "9", newer(7)), // no room
    mk("x3", "ROOM_NEW", "8", { ...newer(8), order_type: "NORMAL" }),
    mk("o1", "ROOM_OLD", "1", older(1)),
    mk("o2", "ROOM_OLD", "2", older(2)),
    mk("o4", "ROOM_OLD", "4", older(4)),
  ];
  const an = analyzeAuctionRows(rowsFor(orders), orders.length);
  check("focus room is the newest room", an.focusRoomId, "ROOM_NEW");
  check("rooms found", an.rooms.map((r) => r.roomId), ["ROOM_NEW", "ROOM_OLD"]);
  const rn = an.rooms[0], ro = an.rooms[1];
  ok("newest room is fully covered only because an older room is in the window", rn.fullyCovered === true && ro.fullyCovered === false);
  check("older room is NOT claimed complete (window may cut it off)", ro.missingNumbers, null);
  check("numbering restarts per room (both rooms start at 1)", [rn.auctionNoMin, ro.auctionNoMin], [1, 1]);
  check("missing numbers reported for the covered room", rn.missingNumbers, [4, 6, 7]);
  check("duplicate auction number detected", rn.duplicateAuctionNos.map((d) => d.auctionNo), ["5"]);
  check("unpaid-cancelled counted", rn.unpaidCancelled, 1);
  check("exception: non-auction", an.exceptionCounts["NON_AUCTION"], 1);
  check("exception: no room id", an.exceptionCounts["NO_ROOM_ID"], 1);
  check("exception: non-numeric sku", an.exceptionCounts["NON_NUMERIC_SKU"], 1);
  check("exception: duplicate auction no", an.exceptionCounts["DUPLICATE_AUCTION_NO_IN_ROOM"], 1);
  check("order type counts", an.orderTypeCounts["AUCTION"], 10);
  check("combined package group found", an.combineGroups.map((g) => [g.autoCombineGroupId, g.auctionNos.join(",")]), [["G1", "2,3"]]);
  check("sku_name mismatch flagged", analyzeAuctionRows(rowsFor([mk("m1", "R", "10", {}, { sku_name: "Gucci" })]), 1).exceptionCounts["SKU_NAME_MISMATCH"], 1);
  check("empty window is safe", analyzeAuctionRows([], 0).focusRoomId, null);

  // ---------- Milestone 2 data layer: orders, slots, rooms, groups, packages, matches ----------
  const { importOrders, ImportInProgressError, getRoomView, getOrder, getSlot, getGroup, getPackage, getRoom, getRoomsIndex } = await import("../src/lib/tiktok/order-store");
  const { selectMatch, voidMatch, getMatch, matchHealth, linkRoomToSession, unlinkRoom, getSessionLink, getRoomSession, MatchError } = await import("../src/lib/tiktok/matches");
  const { K, assertNoPersonalData, toOrderContent } = await import("../src/lib/tiktok/records");
  const { normalizeMoney, toCents } = await import("../src/lib/tiktok/money");

  const ROOM_NEW = "7706328801780763422", ROOM_OLD = "7705645796045179662";
  const iso2 = (x: string) => Math.floor(Date.parse(x) / 1000);
  interface Spec { id: string; line: string; room: string | null; sku: string | null; price: string; created: string; paid?: string | null; status?: string; group?: string | null; pkg?: string | null; tracking?: string | null; type?: string; cancel?: [string, string]; extra?: Record<string, unknown> }
  const fx = (o: Spec) => ({
    id: o.id, order_type: o.type ?? "AUCTION", status: o.status ?? "IN_TRANSIT", create_time: iso2(o.created),
    paid_time: o.paid === null ? undefined : iso2(o.paid ?? new Date(Date.parse(o.created) + 4000).toISOString()), update_time: iso2(o.created) + 100,
    auto_combine_group_id: o.group ?? undefined, packages: o.pkg ? [{ id: o.pkg }] : [], shipping_provider: "USPS", shipping_type: "TIKTOK",
    delivery_option_name: "Standard shipping", fulfillment_type: "FULFILLMENT_BY_SELLER", tracking_number: o.tracking ?? undefined,
    cancel_reason: o.cancel?.[0], cancellation_initiator: o.cancel?.[1],
    // personal data TikTok really sends — must NEVER reach storage:
    buyer_email: "SECRET@x.test", buyer_nickname: "SECRET-NICK", buyer_message: "SECRET-MSG", user_id: "SECRET-UID", payment_method_name: "SECRET-CARD",
    recipient_address: { full_address: "SECRET-ADDR", phone_number: "SECRET-PHONE", name: "SECRET-NAME" },
    line_items: [{ id: o.line, room_id: o.room ?? undefined, seller_sku: o.sku ?? undefined, sku_name: o.sku ?? undefined, sale_price: o.price, original_price: o.price, seller_discount: "0", platform_discount: "0",
      currency: "USD", display_status: o.status ?? "IN_TRANSIT", package_id: o.pkg ?? undefined, tracking_number: o.tracking ?? undefined, product_id: "1732774835048780102", sku_id: "1732774836822774086", cancel_reason: o.cancel?.[0] }],
    ...o.extra,
  });
  // Values below are real ids / prices / packages from the production sample; full tracking numbers, product ids and a few prices were not in the sample and are placeholders.
  const G_A = "2994363699444683427", P_A = "1158216285475607203", G_B = "2994369010644325239", P_B = "1158216338944660343";
  const base = [
    fx({ id: "577669111496872611", line: "577669111497003683", room: ROOM_NEW, sku: "25", price: "3", created: "2026-11-10T00:38:34Z", group: G_A, pkg: P_A, tracking: "TEST000000000000001963" }),
    fx({ id: "577669125000696483", line: "577669125000827555", room: ROOM_NEW, sku: "29", price: "15", created: "2026-11-10T00:45:42Z", group: G_A, pkg: P_A, tracking: "TEST000000000000001963" }),
    fx({ id: "577669137360589475", line: "577669137360720547", room: ROOM_NEW, sku: "33", price: "21", created: "2026-11-10T00:51:39Z", group: G_A, pkg: P_A, tracking: "TEST000000000000001963" }),
    fx({ id: "577669155394917027", line: "577669155395048099", room: ROOM_NEW, sku: "39", price: "21", created: "2026-11-10T01:01:00Z", group: G_A, pkg: P_A, tracking: "TEST000000000000001963" }),
    fx({ id: "577669157018243959", line: "577669157018375031", room: ROOM_NEW, sku: "40", price: "23", created: "2026-11-10T01:02:01Z", group: G_B, pkg: P_B, tracking: "TEST000000000000002014" }),
    fx({ id: "577669162669282167", line: "577669162669413239", room: ROOM_NEW, sku: "43", price: "14", created: "2026-11-10T01:05:35Z", group: G_B, pkg: P_B, tracking: "TEST000000000000002014" }),
    // SAME auction number (#40) in the OLDER room — must be a different slot
    fx({ id: "577665408387682855", line: "577665408387814000", room: ROOM_OLD, sku: "40", price: "10", created: "2026-11-08T05:00:00Z", group: "2993754139863716391", pkg: "1158197726292513319", tracking: "TEST000000000000009999" }),
    // an unpaid auction win (real earlier-sample order #73: cancelled by SYSTEM, never paid)
    fx({ id: "577629543777538988", line: "577629543777670060", room: "7698947531304864543", sku: "73", price: "62", created: "2026-10-21T22:00:00Z", paid: null, status: "CANCELLED", cancel: ["Customer overdue to pay", "SYSTEM"] }),
    fx({ id: "900000000000000001", line: "900000000000000002", room: null, sku: "5", price: "9", created: "2026-11-10T01:06:00Z", type: "NORMAL" }), // not an auction, no room
  ];

  const keysBefore = new Set(mem.m.keys());
  const writesBefore = mem.writes;
  const imp1 = await importOrders(base);
  check("first import creates every order", [imp1.created, imp1.updated, imp1.unchanged], [9, 0, 0]);
  check("rooms touched: new, old, unpaid-sample room", [...imp1.roomsTouched].sort(), [ROOM_NEW, ROOM_OLD, "7698947531304864543"].sort());
  check("the non-auction / roomless order is parked as unslotted, not slotted", imp1.unslotted, 1);
  check("slots written (6 + 1 + 1)", imp1.slotsWritten, 8);

  const newKeys = [...mem.m.keys()].filter((k) => !keysBefore.has(k));
  ok("every new key is inside the TikTok dev namespace", newKeys.length > 0 && newKeys.every((k) => k.startsWith("amoruh:tiktok:dev:")));
  ok("nothing outside the TikTok namespace was created (no SaleRecord / inventory / product keys)", ![...mem.m.keys()].some((k) => !k.startsWith("amoruh:tiktok:")));
  const storedJson = newKeys.map((k) => JSON.stringify(mem.m.get(k))).join("\n");
  ok("NO buyer / recipient / contact / payment data in any stored record", !/SECRET/.test(storedJson));
  ok("tracking numbers ARE preserved in full", storedJson.includes("TEST000000000000001963"));

  const o25 = (await getOrder("577669111496872611"))!;
  check("order id kept as exact string", o25.orderId, "577669111496872611");
  check("line item id kept as exact string", o25.lineItems[0].lineItemId, "577669111497003683");
  check("room id is a string", o25.roomId, ROOM_NEW);
  check("auction number string + numeric sort key", [o25.lineItems[0].sellerSku, o25.lineItems[0].auctionNo], ["25", 25]);
  check("sale price kept as the decimal string TikTok sent", o25.lineItems[0].salePrice, "3");
  check("paid state, status and version recorded", [o25.paidState, o25.status, o25.version, o25.statusHistory.length], ["PAID", "IN_TRANSIT", 1, 1]);
  check("product / sku ids kept as strings", [o25.lineItems[0].productId, o25.lineItems[0].skuId], ["1732774835048780102", "1732774836822774086"]);

  // ---- slots are keyed by (room_id, seller_sku) ----
  const sNew40 = (await getSlot(ROOM_NEW, "40"))!, sOld40 = (await getSlot(ROOM_OLD, "40"))!;
  ok("auction #40 exists as TWO separate slots, one per room", !!sNew40 && !!sOld40 && sNew40.entries[0].orderId !== sOld40.entries[0].orderId);
  check("…and their storage keys differ", [K.slot(ROOM_NEW, "40") !== K.slot(ROOM_OLD, "40"), sNew40.roomId, sOld40.roomId], [true, ROOM_NEW, ROOM_OLD]);
  check("room summary counts", (({ slotCount, orderCount, paidSlots, auctionNoMin, auctionNoMax }) => ({ slotCount, orderCount, paidSlots, auctionNoMin, auctionNoMax }))((await getRoom(ROOM_NEW))!), { slotCount: 6, orderCount: 6, paidSlots: 6, auctionNoMin: 25, auctionNoMax: 43 });
  check("rooms index is newest-first", (await getRoomsIndex())!.rooms.map((x) => x.roomId), [ROOM_NEW, ROOM_OLD, "7698947531304864543"]);

  // ---- unpaid / cancelled representation ----
  const unpaid = (await getSlot("7698947531304864543", "73"))!;
  check("unpaid win is stored, not dropped", [unpaid.state, unpaid.matchable, unpaid.activeEntry, unpaid.salePrice], ["UNPAID_CANCELLED", false, null, "62"]);
  const unpaidOrder = (await getOrder("577629543777538988"))!;
  check("order keeps TikTok's cancel details and has no paid_time", [unpaidOrder.paidState, unpaidOrder.status, unpaidOrder.paidTime, unpaidOrder.cancelReason, unpaidOrder.cancellationInitiator], ["UNPAID_CANCELLED", "CANCELLED", null, "Customer overdue to pay", "SYSTEM"]);
  await throwsAsync("an unpaid slot cannot be matched", () => selectMatch({ roomId: "7698947531304864543", sellerSku: "73", productId: "p_1" }), /cannot be matched/);
  let matchErr: unknown = null;
  try { await selectMatch({ roomId: "7698947531304864543", sellerSku: "73", productId: "p_1" }); } catch (e) { matchErr = e; }
  ok("…with the typed error code SLOT_NOT_MATCHABLE", matchErr instanceof MatchError && matchErr.code === "SLOT_NOT_MATCHABLE");
  const un = (await mem.get<{ entries: { orderId: string; reason: string }[] }>(K.unslotted()))!;
  check("unslotted list records why", un.entries.map((e) => [e.orderId, e.reason]), [["900000000000000001", "NON_AUCTION"]]);

  // ---- combined packages ----
  const gA = (await getGroup(G_A))!;
  check("combine group lists all 4 orders / the one package / the room", [gA.orderIds.length, gA.packageIds, gA.roomIds], [4, [P_A], [ROOM_NEW]]);
  check("combine group remembers which auction slots it holds", gA.slotKeys.map((x) => x.sellerSku).sort(), ["25", "29", "33", "39"]);
  const pA = (await getPackage(P_A))!;
  check("package: orders, line items, shared tracking, carrier", [pA.orderIds.length, pA.lineItemIds.length, pA.trackingNumbers, pA.carrier, pA.autoCombineGroupId], [4, 4, ["TEST000000000000001963"], "USPS", G_A]);

  // ---- duplicate imports ----
  const snap = () => JSON.stringify([...mem.m.entries()].filter(([k]) => !k.includes(":import")).sort(([a], [b]) => a.localeCompare(b)));
  const snapBefore = snap();
  const wBefore = mem.writes;
  const imp2 = await importOrders(base);
  check("re-importing identical data creates / updates nothing", [imp2.created, imp2.updated, imp2.unchanged, imp2.slotsWritten], [0, 0, 9, 0]);
  check("…and rewrites no order / slot / room / group / package", snap(), snapBefore);
  check("…only the import log + index are written", mem.writes - wBefore, 2);
  const imp3 = await importOrders([base[0], base[0], base[1]]);
  check("duplicates inside one batch are collapsed and counted", [imp3.uniqueOrders, imp3.duplicatesInBatch, imp3.created], [2, 1, 0]);
  check("slot never gains a duplicate entry", (await getSlot(ROOM_NEW, "25"))!.entries.length, 1);

  // ---- concurrent importer is refused ----
  await mem.set(K.importLock(), "lock-someone-else", { ex: 60 });
  await throwsAsync("a second importer fails fast while the lock is held", () => importOrders(base), /already running/);
  let lockErr: unknown = null;
  try { await importOrders(base); } catch (e) { lockErr = e; }
  ok("…with a typed ImportInProgressError (route maps it to HTTP 409)", lockErr instanceof ImportInProgressError);
  await mem.del(K.importLock());

  // ---- explicit matches (no SaleRecord, no inventory) ----
  const m1 = await selectMatch({ roomId: ROOM_NEW, sellerSku: "25", productId: "p_gucci_bloom", selectedBy: "tester" });
  check("match links slot → order → AMORUH product by explicit ids", [m1.roomId, m1.sellerSku, m1.orderId, m1.lineItemId, m1.productId, m1.state, m1.version], [ROOM_NEW, "25", "577669111496872611", "577669111497003683", "p_gucci_bloom", "selected", 1]);
  check("match snapshots TikTok's price and starts with NO sale record", [m1.tiktokSalePrice, m1.saleRecordId, m1.confirmedAt], ["3", null, null]);
  check("changing the product bumps the version", (await selectMatch({ roomId: ROOM_NEW, sellerSku: "25", productId: "p_afnan" })).version, 2);
  await throwsAsync("stale expectedVersion is rejected", () => selectMatch({ roomId: ROOM_NEW, sellerSku: "25", productId: "p_x", expectedVersion: 1 }), /changed since/);
  await throwsAsync("empty product id rejected", () => selectMatch({ roomId: ROOM_NEW, sellerSku: "29", productId: " " }), /product id/);
  await throwsAsync("unknown slot rejected", () => selectMatch({ roomId: ROOM_NEW, sellerSku: "999", productId: "p" }), /No TikTok auction slot/);
  check("a match for #40 in one room does not touch #40 in the other room", [(await selectMatch({ roomId: ROOM_NEW, sellerSku: "40", productId: "p_a" })).roomId, await getMatch(ROOM_OLD, "40")], [ROOM_NEW, null]);
  check("health is OK while TikTok still says paid", await matchHealth(ROOM_NEW, "25"), "OK");

  const view = (await getRoomView(ROOM_NEW))!;
  check("room view is sorted by auction number", view.rows.map((r) => r.auctionNo), [25, 29, 33, 39, 40, 43]);
  const row25 = view.rows[0];
  check("room view row joins price / package / group size / match", [row25.salePrice, row25.packageId, row25.ordersInGroup, row25.trackingLast4, row25.match?.productId, row25.match?.health], ["3", P_A, 4, "1963", "p_afnan", "OK"]);
  ok("room view never exposes a full tracking number or personal data", !/TEST000000000000001963|SECRET/.test(JSON.stringify(view)));

  // ---- TikTok later cancels a paid order: record the flip, never edit silently ----
  const cancelled = fx({ id: "577669111496872611", line: "577669111497003683", room: ROOM_NEW, sku: "25", price: "3", created: "2026-11-10T00:38:34Z", status: "CANCELLED", group: G_A, pkg: P_A, tracking: "TEST000000000000001963", cancel: ["Seller cancelled", "SELLER"] });
  const imp4 = await importOrders([cancelled]);
  check("a status change is an update, counted as a status change", [imp4.created, imp4.updated, imp4.statusChanges], [0, 1, 1]);
  const o25b = (await getOrder("577669111496872611"))!;
  check("history keeps both states; version bumped", [o25b.version, o25b.statusHistory.map((h) => h.paidState)], [2, ["PAID", "CANCELLED_AFTER_PAID"]]);
  const slot25 = (await getSlot(ROOM_NEW, "25"))!;
  check("slot is no longer matchable", [slot25.state, slot25.matchable], ["CANCELLED_AFTER_PAID", false]);
  check("existing match is flagged STALE, not deleted or changed", [await matchHealth(ROOM_NEW, "25"), (await getMatch(ROOM_NEW, "25"))!.productId], ["STALE_ORDER_NOT_PAID", "p_afnan"]);
  check("room counters follow", (await getRoom(ROOM_NEW))!.paidSlots, 5);
  check("the group still holds the order (it is still a TikTok order)", (await getGroup(G_A))!.orderIds.length, 4);
  const voided = await voidMatch({ roomId: ROOM_NEW, sellerSku: "25", reason: "order cancelled on TikTok" });
  check("clearing a match keeps an audit record", [voided.state, voided.voidReason], ["voided", "order cancelled on TikTok"]);

  // ---- same auction number re-sold after a cancel, and true conflicts ----
  await importOrders([
    fx({ id: "800000000000000001", line: "800000000000000011", room: ROOM_NEW, sku: "50", price: "7", created: "2026-11-10T01:10:00Z", paid: null, status: "CANCELLED", cancel: ["Customer overdue to pay", "SYSTEM"] }),
    fx({ id: "800000000000000002", line: "800000000000000012", room: ROOM_NEW, sku: "50", price: "9", created: "2026-11-10T01:12:00Z" }),
  ]);
  const s50 = (await getSlot(ROOM_NEW, "50"))!;
  check("cancelled attempt + later paid order → slot is PAID with the paid order active", [s50.state, s50.activeEntry?.orderId, s50.salePrice, s50.entries.length], ["PAID", "800000000000000002", "9", 2]);
  await importOrders([
    fx({ id: "800000000000000003", line: "800000000000000013", room: ROOM_NEW, sku: "51", price: "5", created: "2026-11-10T01:13:00Z" }),
    fx({ id: "800000000000000004", line: "800000000000000014", room: ROOM_NEW, sku: "51", price: "6", created: "2026-11-10T01:14:00Z" }),
  ]);
  check("two PAID orders for one slot → CONFLICT", (await getSlot(ROOM_NEW, "51"))!.state, "CONFLICT");
  await throwsAsync("a conflicting slot cannot be matched", () => selectMatch({ roomId: ROOM_NEW, sellerSku: "51", productId: "p" }), /more than one paid/);

  // ---- an order moving to another combine group is removed from the old one ----
  await importOrders([fx({ id: "577669162669282167", line: "577669162669413239", room: ROOM_NEW, sku: "43", price: "14", created: "2026-11-10T01:05:35Z", group: "2994369999999999999", pkg: "1158216999999999999", tracking: "TEST000000000000002014" })]);
  check("old group no longer lists the moved order", (await getGroup(G_B))!.orderIds, ["577669157018243959"]);
  check("new group lists it", (await getGroup("2994369999999999999"))!.orderIds, ["577669162669282167"]);
  check("old package no longer lists it", (await getPackage(P_B))!.orderIds, ["577669157018243959"]);

  // ---- rooms are never merged; sessions only LINK rooms ----
  const slotsSnap = JSON.stringify([...mem.m.entries()].filter(([k]) => k.includes(":slot:")).sort(([a], [b]) => a.localeCompare(b)));
  await linkRoomToSession("session_A", ROOM_NEW);
  const link = await linkRoomToSession("session_A", ROOM_OLD);
  check("one AMORUH session can hold several TikTok rooms", link.roomIds, [ROOM_NEW, ROOM_OLD]);
  check("room → session lookup", (await getRoomSession(ROOM_OLD))!.sessionId, "session_A");
  check("linking never changes any slot", JSON.stringify([...mem.m.entries()].filter(([k]) => k.includes(":slot:")).sort(([a], [b]) => a.localeCompare(b))), slotsSnap);
  check("#40 is still two distinct slots after linking", [(await getSlot(ROOM_NEW, "40"))!.roomId, (await getSlot(ROOM_OLD, "40"))!.roomId], [ROOM_NEW, ROOM_OLD]);
  await throwsAsync("a room cannot belong to two sessions", () => linkRoomToSession("session_B", ROOM_NEW), /already linked/);
  await throwsAsync("unknown room cannot be linked", () => linkRoomToSession("session_A", "123"), /Unknown TikTok room/);
  await unlinkRoom(ROOM_OLD);
  check("unlink removes only the association", [(await getSessionLink("session_A"))!.roomIds, await getRoomSession(ROOM_OLD), !!(await getRoom(ROOM_OLD))], [[ROOM_NEW], null, true]);

  // ---- guards ----
  throwsSync("personal-data guard rejects a buyer field", () => assertNoPersonalData({ ok: 1, nested: { buyer_email: "x" } }), /Refusing to store/);
  throwsSync("…and recipient / address / phone fields", () => assertNoPersonalData([{ recipient_address: {} }]), /Refusing to store/);
  const noLeak = toOrderContent(fx({ id: "1", line: "2", room: "3", sku: "4", price: "5", created: "2026-11-10T00:00:00Z" }))!;
  ok("projection of a raw order contains no personal data", !/SECRET/.test(JSON.stringify(noLeak)));
  assertNoPersonalData(noLeak);
  check("bad money is not stored as a number, it is flagged", toOrderContent(fx({ id: "1", line: "2", room: "3", sku: "4", price: "12,5", created: "2026-11-10T00:00:00Z" }))!.anomalies, ["BAD_MONEY:salePrice", "BAD_MONEY:originalPrice"]);
  check("normalizeMoney", [normalizeMoney("4.89"), normalizeMoney("007"), normalizeMoney("1e3"), normalizeMoney("abc"), normalizeMoney(null)], ["4.89", "7", null, null, null]);
  check("toCents is exact", [toCents("4.89"), toCents("31"), toCents("0.07"), toCents("19.99"), toCents("1.005")], [489, 3100, 7, 1999, null]);
  ok("no new key was written outside the TikTok namespace, and SaleRecord-style keys never appear", ![...mem.m.keys()].some((k) => !k.startsWith("amoruh:tiktok:") ));
  void writesBefore;

  // ---------- Bounded per-room import ----------
  const { scanForRoom, importRoom, RoomImportError, resolveLimits, ROOM_LIMIT_DEFAULTS, ROOM_LIMIT_CEILING } = await import("../src/lib/tiktok/import-room");
  const RM = "7705000000000000001", RM_OTHER = "7705000000000000002", RM_OLDER = "7705000000000000003";
  const T0 = Math.floor(Date.parse("2026-11-08T04:00:00Z") / 1000);
  const isoSec = (sec: number) => new Date(sec * 1000).toISOString();
  let rmN = 0;
  const rmId = () => `91${String(++rmN).padStart(16, "0")}`;
  const rmOrder = (room: string | null, sku: string, sec: number, extra: Partial<Spec> = {}) =>
    fx({ id: rmId(), line: rmId(), room, sku, price: String(10 + (rmN % 7)), created: isoSec(sec), group: `5000${sku}`, pkg: `6000${sku}`, tracking: `TRK${sku.padStart(6, "0")}`, ...extra });
  const rmTimeOf = (o: ReturnType<typeof fx>) => o.create_time as number;
  const newestFirst = (xs: ReturnType<typeof fx>[]) => [...xs].sort((a, b) => rmTimeOf(b) - rmTimeOf(a));
  const pagesOf = (list: unknown[], size: number) => {
    const calls: (string | undefined)[] = [];
    const fetchPage = async (token?: string) => {
      calls.push(token);
      const i = token ? Number(token) : 0;
      const orders = list.slice(i, i + size);
      return { orders, next: i + size < list.length ? String(i + size) : null, requestId: `req-${calls.length}` };
    };
    return { fetchPage, calls };
  };

  // 30-auction room: #20 unpaid, #3/#9/#15 combined, #4/#5 combined, two stray non-room orders inside it
  const roomOrders30 = Array.from({ length: 30 }, (_, i) => i + 1).map((n) => {
    const sku = String(n);
    const grp: Partial<Spec> = [3, 9, 15].includes(n) ? { group: "991", pkg: "881" } : [4, 5].includes(n) ? { group: "992", pkg: "882" } : {};
    const un: Partial<Spec> = n === 20 ? { paid: null, status: "CANCELLED", cancel: ["Customer overdue to pay", "SYSTEM"], pkg: null } : {};
    return rmOrder(RM, sku, T0 + n * 60, { ...grp, ...un });
  });
  const strays = [rmOrder(null, "7", T0 + 14 * 60 + 30, { type: "NORMAL", group: null, pkg: null }), rmOrder(null, "8", T0 + 22 * 60 + 30, { type: "NORMAL", group: null, pkg: null })];
  const newerOnes = Array.from({ length: 12 }, (_, i) => rmOrder(RM_OTHER, String(i + 1), T0 + 100000 + i));
  const olderOnes = Array.from({ length: 10 }, (_, i) => rmOrder(RM_OLDER, String(i + 1), T0 - 1000 - i));
  const world = newestFirst([...newerOnes, ...roomOrders30, ...strays, ...olderOnes]);

  // --- scan: boundary logic ---
  const pg1 = pagesOf(world, 10);
  const sc1 = await scanForRoom({ roomId: RM, fetchPage: pg1.fetchPage });
  check("scan collects exactly the room's orders", sc1.roomOrders.length, 30);
  check("scan stops at the confirmed boundary, not at the end of history", [sc1.stats.boundary, sc1.stats.inspected, sc1.stats.pages, pg1.calls.length], ["streak", 12 + 30 + 2 + 8, 6, 6]);
  ok("stray non-room orders inside the room did not end the scan", sc1.roomOrders.length === 30 && sc1.stats.inspected === 52);
  check("room time window recorded", [sc1.stats.firstRoomOrderTime, sc1.stats.lastRoomOrderTime], [T0 + 60, T0 + 1800]);
  const early = await scanForRoom({ roomId: RM, fetchPage: pagesOf(world, 10).fetchPage, limits: { boundaryConfirm: 1 } });
  ok("boundaryConfirm=1 would have stopped early at a stray (so the default of 8 matters)", early.roomOrders.length < 30);
  const tail = await scanForRoom({ roomId: RM, fetchPage: pagesOf(newestFirst([...newerOnes, ...roomOrders30]), 10).fetchPage });
  check("room at the very end of TikTok's list → boundary 'exhausted'", [tail.roomOrders.length, tail.stats.boundary], [30, "exhausted"]);

  // --- scan: failures never return a partial room ---
  const fail1 = async (label: string, limits: Record<string, number>, code: string, pages = pagesOf(world, 10), now?: () => number) => {
    let err: unknown = null;
    try { await scanForRoom({ roomId: RM, fetchPage: pages.fetchPage, limits, now }); } catch (e) { err = e; }
    ok(`${label} → RoomImportError ${code}, "Nothing was imported"`, err instanceof RoomImportError && err.code === code && /Nothing was imported/.test(err.message) && !!err.stats);
  };
  await fail1("page limit", { maxPages: 3 }, "MAX_PAGES");
  await fail1("inspected-orders limit", { maxOrdersInspected: 20 }, "MAX_ORDERS_INSPECTED");
  let clock = 0;
  const slow = pagesOf(world, 10);
  const slowFetch = async (t?: string) => { clock += 100; return slow.fetchPage(t); };
  let rtErr: unknown = null;
  try { await scanForRoom({ roomId: RM, fetchPage: slowFetch, limits: { maxRuntimeMs: 150 }, now: () => clock }); } catch (e) { rtErr = e; }
  ok("runtime limit → MAX_RUNTIME", rtErr instanceof RoomImportError && rtErr.code === "MAX_RUNTIME");
  let nf: unknown = null;
  try { await scanForRoom({ roomId: "7705999999999999999", fetchPage: pagesOf(world, 10).fetchPage }); } catch (e) { nf = e; }
  ok("unknown room → ROOM_NOT_FOUND after exhausting the list", nf instanceof RoomImportError && nf.code === "ROOM_NOT_FOUND" && nf.stats?.entered === false);
  const shuffled = [...world]; [shuffled[3], shuffled[40]] = [shuffled[40], shuffled[3]];
  let ord: unknown = null;
  try { await scanForRoom({ roomId: RM, fetchPage: pagesOf(shuffled, 10).fetchPage }); } catch (e) { ord = e; }
  ok("out-of-order results → ORDER_NOT_NEWEST_FIRST (boundary cannot be trusted)", ord instanceof RoomImportError && ord.code === "ORDER_NOT_NEWEST_FIRST");
  let bad: unknown = null;
  try { await scanForRoom({ roomId: "abc", fetchPage: pg1.fetchPage }); } catch (e) { bad = e; }
  ok("non-numeric room id rejected", bad instanceof RoomImportError && bad.code === "BAD_ROOM_ID");
  check("limits default and clamp to ceilings", [resolveLimits({}), resolveLimits({ maxPages: 9999, maxOrdersInspected: 99999, maxRuntimeMs: 1e9, boundaryConfirm: -5 })], [ROOM_LIMIT_DEFAULTS, { ...ROOM_LIMIT_CEILING, boundaryConfirm: ROOM_LIMIT_DEFAULTS.boundaryConfirm }]);

  // --- importRoom against the store: partial room already stored (#11–#30), complete it ---
  const rmIds = (n: number) => roomOrders30[n - 1].id as string;
  await importOrders(roomOrders30.filter((_, i) => i + 1 >= 11)); // the earlier capped import saw only #11–#30
  const holdBefore = new Map<string, { hash: string; version: number; first: string }>();
  for (let n = 11; n <= 30; n++) { const o = (await getOrder(rmIds(n)))!; holdBefore.set(rmIds(n), { hash: o.contentHash, version: o.version, first: o.firstSeenAt }); }
  check("before: room holds only #11–#30", [(await getRoom(RM))!.auctionNoMin, (await getRoom(RM))!.slotCount], [11, 20]);

  const storeSnap = () => JSON.stringify([...mem.m.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const snapPartial = storeSnap();
  let failedImport: unknown = null;
  try { await importRoom(RM, { limits: { maxPages: 2 } }, { fetchPage: pagesOf(world, 10).fetchPage }); } catch (e) { failedImport = e; }
  ok("a limit hit during importRoom throws", failedImport instanceof RoomImportError);
  check("…and the store is byte-for-byte unchanged (no partial room written)", storeSnap(), snapPartial);

  const dry = await importRoom(RM, { dryRun: true }, { fetchPage: pagesOf(world, 10).fetchPage });
  check("dry run reports the full room without writing", [dry.dryRun, dry.scanned.orders, dry.scanned.slots, dry.import, storeSnap() === snapPartial], [true, 30, 30, null, true]);

  const done = await importRoom(RM, {}, { fetchPage: pagesOf(world, 10).fetchPage });
  check("import completes the room", [done.complete, done.scan.boundary, done.scanned.orders, done.scanned.slots], [true, "streak", 30, 30]);
  check("final range starts at #1 with no gaps", [done.scanned.auctionNoMin, done.scanned.auctionNoMax, done.scanned.startsAtOne, done.scanned.missingNumbers], [1, 30, true, []]);
  check("paid / unpaid counts", [done.scanned.paid, done.scanned.unpaidCancelled], [29, 1]);
  check("combined groups / multi-order groups / packages", [done.scanned.combinedGroups, done.scanned.multiOrderGroups, done.scanned.ordersInMultiOrderGroups, done.scanned.packages], [27, 2, 5, 26]);
  check("no anomalies, no duplicate auction numbers", [done.scanned.exceptions, done.scanned.duplicateAuctionNos, done.import!.anomalyCounts], [{}, [], {}]);
  check("only the 10 missing orders were created; the 20 already stored were left alone", [done.import!.created, done.import!.updated, done.import!.unchanged], [10, 0, 20]);
  check("stored room matches what was scanned", [done.stored, done.consistent], [{ slotCount: 30, orderCount: 30, paidSlots: 29, unpaidSlots: 1, conflictSlots: 0, auctionNoMin: 1, auctionNoMax: 30 }, true]);
  let heldSame = 0;
  for (const [id, b] of holdBefore) { const o = (await getOrder(id))!; if (o.contentHash === b.hash && o.version === b.version && o.firstSeenAt === b.first) heldSame++; }
  check("the previously stored #11–#30 are unchanged (hash, version, first-seen)", heldSame, 20);
  check("unpaid #20 is stored but not matchable", [(await getSlot(RM, "20"))!.state, (await getSlot(RM, "20"))!.matchable], ["UNPAID_CANCELLED", false]);
  ok("orders of OTHER rooms and stray orders were not imported", !mem.m.has(K.order(newerOnes[0].id as string)) && !mem.m.has(K.order(olderOnes[0].id as string)) && !mem.m.has(K.order(strays[0].id as string)));

  // --- re-running the same room import ---
  const keysAfter = [...mem.m.keys()].filter((k) => !k.includes(":import")).length;
  const snapDone = JSON.stringify([...mem.m.entries()].filter(([k]) => !k.includes(":import")).sort(([a], [b]) => a.localeCompare(b)));
  const again = await importRoom(RM, {}, { fetchPage: pagesOf(world, 10).fetchPage });
  check("re-run: nothing created or updated", [again.import!.created, again.import!.updated, again.import!.unchanged, again.import!.slotsWritten], [0, 0, 30, 0]);
  check("re-run: no new keys and no changed records", [[...mem.m.keys()].filter((k) => !k.includes(":import")).length, JSON.stringify([...mem.m.entries()].filter(([k]) => !k.includes(":import")).sort(([a], [b]) => a.localeCompare(b))) === snapDone], [keysAfter, true]);
  check("re-run: still exactly 30 orders and 30 slots for the room", [[...mem.m.keys()].filter((k) => k.includes(":slot:" + RM + ":")).length, (await getRoom(RM))!.orderCount], [30, 30]);

  // --- completeness is honest about gaps / a room that does not start at #1 ---
  const gapRoom = "7705000000000000004";
  const gapOrders = [5, 6, 8, 9].map((n) => rmOrder(gapRoom, String(n), T0 + 200000 + n * 60));
  const gap = await importRoom(gapRoom, { dryRun: true }, { fetchPage: pagesOf(newestFirst([...gapOrders, ...olderOnes]), 10).fetchPage });
  check("gaps and a start other than #1 are reported, not hidden", [gap.scanned.startsAtOne, gap.scanned.auctionNoMin, gap.scanned.missingNumbers], [false, 5, [1, 2, 3, 4, 7]]);

  // ---------- Go Live TikTok panel: totals, search, saved matches, latest-room refresh ----------
  const { computeTotals, searchProducts } = await import("../src/lib/tiktok/live-totals");
  const { getPanel, setPanelMatch } = await import("../src/lib/tiktok/live-panel");

  const prodMap = new Map([
    ["p_a", { id: "p_a", cost: 18, inventory: 6 }],
    ["p_b", { id: "p_b", cost: 7.25, inventory: 1 }],
    ["p_free", { id: "p_free", cost: 0, inventory: 3 }],
  ]);
  const R = (sku: string, state: string, price: string | null, match: { productId: string; health: string } | null) => ({ sellerSku: sku, state: state as never, salePrice: price, match: match as never });
  const tot = computeTotals([
    R("1", "PAID", "36", { productId: "p_a", health: "OK" }),          // $36 - $18 = $18
    R("2", "PAID", "4.89", { productId: "p_b", health: "OK" }),        // $4.89 - $7.25 = -$2.36
    R("3", "PAID", "10", { productId: "p_free", health: "OK" }),       // matched but no cost on file
    R("4", "PAID", "22", null),                                          // paid, needs product
    R("5", "UNPAID_CANCELLED", "50", null),                              // never counted
    R("6", "UNPAID_CANCELLED", "9", { productId: "p_a", health: "OK" }), // match on an unpaid auction → stale, excluded
    R("7", "PAID", "15", { productId: "p_a", health: "STALE_ORDER_NOT_PAID" }), // order changed → excluded, needs attention
    R("8", "PAID", "12", { productId: "p_gone", health: "OK" }),         // product deleted → excluded
    R("9", "UNPAID_OPEN", "8", null),
    R("10", "CONFLICT", "8", null),
    R("11", "PAID", "36", { productId: "p_a", health: "OK" }),
  ], prodMap);
  check("revenue counts only matched, still-paid auctions (36+4.89+10+36)", tot.revenueCents, 8689);
  check("cost counts only matched products that have a cost (18+7.25+18)", tot.costCents, 4325);
  check("gross profit uses only rows that have a cost (36+4.89+36-43.25)", tot.profitCents, 3364);
  check("units matched", tot.unitsMatched, 4);
  check("matched without cost is surfaced", tot.matchedWithoutCost, 1);
  check("needs product = unmatched + stale + missing-product paid auctions", [tot.unmatchedPaid, tot.unmatchedPaidCents], [3, 4900]);
  check("unpaid / cancelled / awaiting / conflict never count", [tot.unpaid, tot.paidAuctions, tot.paidCents], [4, 7, 13589]);
  check("stale and missing-product matches are reported", [tot.staleMatches, tot.missingProduct], [2, 1]);
  check("product usage per product (for the oversold flag)", tot.usage, { p_a: 2, p_b: 1, p_free: 1 });
  check("margin on rows with a cost", Math.round((tot.marginPct ?? 0) * 10) / 10, 43.8);
  check("decimal cents are exact (0.10 × 3 = $0.30, no float drift)", computeTotals([R("a", "PAID", "0.10", { productId: "p_a", health: "OK" }), R("b", "PAID", "0.10", { productId: "p_a", health: "OK" }), R("c", "PAID", "0.10", { productId: "p_a", health: "OK" })], prodMap).revenueCents, 30);
  check("empty room is safe", [computeTotals([], prodMap).revenueCents, computeTotals([], prodMap).marginPct], [0, null]);

  const catalog = [
    { id: "1", name: "9 PM", brand: "Afnan", sku: "AFN-9PM", barcode: "6290171074250", size: "3.4oz", inventory: 4 },
    { id: "2", name: "9 PM Elixir", brand: "Afnan", sku: "AFN-9PM-E", barcode: "6290171999999", size: "3.4oz", inventory: 0 },
    { id: "3", name: "Bloom", brand: "Gucci", sku: "GUC-BLOOM", barcode: "3614227748569", size: "3.4oz", inventory: 2 },
    { id: "4", name: "Light Blue", brand: "Dolce & Gabbana", sku: "DG-LB", barcode: "8057971180431", size: "3.4oz", inventory: 5 },
  ];
  check("search by name", searchProducts(catalog, "bloom").map((p) => p.id), ["3"]);
  check("every typed word may match name, brand or SKU, in any order (9pm hits the SKU)", searchProducts(catalog, "9pm afnan").map((p) => p.id), ["1", "2"]);
  check("search by brand + name", searchProducts(catalog, "afnan 9 pm").map((p) => p.id), ["1", "2"]);
  check("exact barcode ranks first", searchProducts(catalog, "6290171074250").map((p) => p.id), ["1"]);
  check("search by SKU", searchProducts(catalog, "guc-bloom").map((p) => p.id), ["3"]);
  check("in-stock results come before out-of-stock", searchProducts(catalog, "afnan").map((p) => p.id), ["1", "2"]);
  check("empty query returns nothing", searchProducts(catalog, "  ").length, 0);
  check("limit respected", searchProducts(catalog, "3.4oz", 2).length, 2);

  // saved matches through the panel layer (TikTok-side record only)
  const nsBefore = [...mem.m.keys()].filter((k) => !k.startsWith("amoruh:tiktok:")).length;
  const pn0 = await getPanel(RM);
  check("panel rows are sorted by auction number and carry price + state", [pn0.rows.length, pn0.rows[0].sellerSku, pn0.rows[0].state, pn0.rows[29].sellerSku], [30, "1", "PAID", "30"]);
  const row20 = pn0.rows.find((r) => r.sellerSku === "20")!;
  check("unpaid auction is listed, not matchable, keeps its TikTok price", [row20.state, row20.matchable, row20.salePrice !== null], ["UNPAID_CANCELLED", false, true]);
  const set1 = await setPanelMatch({ roomId: RM, sellerSku: "5", productId: "p_a" }, { productExists: async () => true });
  check("choosing a product saves the match", set1.match, { productId: "p_a", version: 1 });
  const pn1 = await getPanel(RM);
  check("…and it shows on the panel as a healthy match", pn1.rows.find((r) => r.sellerSku === "5")!.match, { productId: "p_a", version: 1, health: "OK" });
  check("totals follow the saved matches", computeTotals(pn1.rows, new Map([["p_a", { id: "p_a", cost: 4, inventory: 9 }]])).unitsMatched, 1);
  check("changing the product replaces the match (version 2)", (await setPanelMatch({ roomId: RM, sellerSku: "5", productId: "p_b" })).match, { productId: "p_b", version: 2 });
  await throwsAsync("an unpaid / cancelled auction cannot be matched", () => setPanelMatch({ roomId: RM, sellerSku: "20", productId: "p_a" }), /cannot be matched/);
  await throwsAsync("an unknown product id is refused", () => setPanelMatch({ roomId: RM, sellerSku: "6", productId: "p_zzz" }, { productExists: async () => false }), /no longer exists/);
  check("clearing a match removes it from the panel", [(await setPanelMatch({ roomId: RM, sellerSku: "5", productId: null })).match, (await getPanel(RM)).rows.find((r) => r.sellerSku === "5")!.match], [null, null]);
  check("clearing something that was never matched is a harmless no-op", (await setPanelMatch({ roomId: RM, sellerSku: "6", productId: null })).match, null);
  ok("matching wrote nothing outside the TikTok namespace (no SaleRecord / inventory keys)", [...mem.m.keys()].filter((k) => !k.startsWith("amoruh:tiktok:")).length === nsBefore);

  await setPanelMatch({ roomId: RM, sellerSku: "7", productId: "p_a" });
  await importOrders([fx({ id: roomOrders30[6].id as string, line: (roomOrders30[6].line_items as { id: string }[])[0].id, room: RM, sku: "7", price: "13", created: isoSec(T0 + 7 * 60), status: "CANCELLED", paid: null, cancel: ["Customer overdue to pay", "SYSTEM"], group: "50007", pkg: null })]);
  const pnStale = await getPanel(RM);
  const r7 = pnStale.rows.find((r) => r.sellerSku === "7")!;
  check("TikTok cancels a matched auction → match kept but flagged, auction no longer matchable", [r7.state, r7.match?.health], ["UNPAID_CANCELLED", "STALE_ORDER_NOT_PAID"]);
  check("…and it is excluded from totals (counted as stale)", [computeTotals(pnStale.rows, new Map([["p_a", { id: "p_a", cost: 4, inventory: 9 }]])).unitsMatched, computeTotals(pnStale.rows, new Map([["p_a", { id: "p_a", cost: 4, inventory: 9 }]])).staleMatches], [0, 1]);

  const latestPanel = await getPanel("latest");
  check("'latest' selects the newest stored room", latestPanel.roomId, (await getRoomsIndex())!.rooms[0].roomId);
  check("rooms list is newest first and capped", latestPanel.rooms.map((r) => r.roomId)[0], latestPanel.roomId);
  check("an unknown room is an empty panel, not an error", (await getPanel("123")).rows, []);

  // refresh with "latest": the room of the newest order that carries a room_id
  const refLatest = await importRoom("latest", {}, { fetchPage: pagesOf(world, 10).fetchPage });
  check("'latest' resolves to the room of the newest order and imports it", [refLatest.roomId, refLatest.scanned.orders, refLatest.complete], [RM_OTHER, 12, true]);
  let noRoom: unknown = null;
  try { await importRoom("latest", {}, { fetchPage: pagesOf(strays, 10).fetchPage }); } catch (e) { noRoom = e; }
  ok("'latest' with no LIVE room in the newest orders fails clearly and writes nothing", noRoom instanceof RoomImportError && /No TikTok LIVE room/.test((noRoom as Error).message));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(1);
});
