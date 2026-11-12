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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(1);
});
