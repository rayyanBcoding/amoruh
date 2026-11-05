# TikTok Shop Integration — Phase 1 Readiness Report

Prepared 2026-11-04. **No code has been written and nothing in AMORUH production was modified.** Every TikTok fact below was read from the official TikTok Shop Partner Center documentation (partner.tiktokshop.com/docv2) on this date; each section names its page. Where I could not verify something, it is marked **UNVERIFIED** or **TO CONFIRM** instead of guessed. Sources are listed at the end.

---

## Executive summary

- **Right developer model:** TikTok Shop **seller developer → Custom app** (not a public/SaaS app). It reaches only our own shop, is shared by a private "Authorize link", and normally needs no public-listing review. (create-your-app, tts-developer-types, publish-custom-app)
- **Biggest blocker — please read:** TikTok only lets a seller register as a developer if the shop passed KYB/KYC **and** is eligible. For a **US local seller** (not one of the SEA "Normal review" markets) eligibility comes from **GKA / Account Manager (AM) / SKM** status. A shop with none of those gets **error 36010071 — "Seller Developer registration is unavailable."** We need to know whether AMORUH has a TikTok Shop Account Manager assigned. (seller-developer-onboarding-onepager)
- **Minimum scopes for Phase 1 (both read-only, both "Public" scopes):** `seller.authorization.info` (Shop Authorized Information) and `seller.order.info` (Order Information). No fulfillment/inventory/finance/product scopes.
- **Credentials needed:** only `app_key`, `app_secret` (+ `service_id` to build the authorize link). **There is no separate webhook secret** — TikTok signs webhooks with `HMAC-SHA256(app_key + raw_body, app_secret)`. Access/refresh tokens and `shop_cipher` are *runtime state* (they change), so they belong in Redis (encrypted), not in Vercel env vars.
- **LIVE-friendly facts discovered:** Order APIs now return `room_id` (TikTok LIVE session ID per line item), `buyer_nickname`, `order_type = AUCTION` and `auto_combine_group_id`. These are exactly the keys Phase 2 needs to match AMORUH LIVE sales to TikTok orders.
- **Biggest architecture risk:** our site-wide passcode gate (`src/proxy.ts`) would block TikTok's webhook calls; and local dev currently shares the production Redis, which is unsafe for rotating OAuth tokens. Both have concrete fixes below.

---

## A. Current AMORUH architecture (read-only audit)

| # | Question | Finding |
|---|---|---|
| 1 | Framework / runtime / deploy | Next.js 16.3 (App Router), React 19, TypeScript, Tailwind v4. Vercel serverless (Node runtime routes; `maxDuration = 60` on long routes). Production domain **amoruh.com**; deploys via Vercel CLI. No `vercel.json`. |
| 2 | Database | **Upstash Redis only** (`@upstash/redis`, REST), plus Vercel Blob for invoice PDFs. One shared client in `src/lib/kv.ts` (env `AMORUH_REDIS_URL/TOKEN`, with a `globalThis.__amoruhRedis` hook used by hermetic tests). Keys are namespaced `amoruh:*` (`amoruh:intake:*`, `amoruh:pricing:*`, `amoruh:live:*`, `amoruh:sales:*`, `amoruh:testlive:*`). **Local dev uses the same production Redis** (the dev env file points at it). |
| 3a | Products | `amoruh:products` (single array: id, sku, barcode, brand, name, size, inventory, cost, …). |
| 3b | Inventory | `Product.inventory` plus lot ledger: `amoruh:intake:lots:{productId}`, one array `amoruh:intake:inventory_transactions` (receiving / sale / sale_reversal deltas per lot), receiving events, POs and PO lines. |
| 3c | LIVE sessions | `amoruh:live:session:{id}`, `amoruh:live:sessions_index`, `amoruh:live:session_state:{id}`, presentations per session. |
| 3d | SaleRecord / LIVE order ledger | `amoruh:sales:{id}` (price, quantity, `landedCostAtSale`, `liveSessionId`, `liveOrderNumber`, status, versioning), zsets `amoruh:sales:all` / `by_product`, per-session order sequence `amoruh:live:session_order_seq:{sid}`, append-only audit `amoruh:live:sale_audit:{saleId}`. All mutations are atomic Lua scripts with idempotency keys. |
| 3e | Supplier offers | `amoruh:pricing:*` — supplier uploads → generations → offers, Master Products, match review, leaderboard cache. |
| 4 | API routes | ~85 App Router `route.ts` handlers under `src/app/api/` (auth, dashboard, intake, live, pricing, products, reorder-intelligence, scan, state, tv, events SSE). No server actions found. |
| 5 | Jobs / cron / polling | **None.** No cron, no queue. The only polling is client-side (Go Live 4 s) and an SSE route that polls a Redis version counter. Long work is done as resumable request loops (e.g. `pricing/process`). |
| 6 | Webhooks | **None exist.** Note: `src/proxy.ts` is a site-wide passcode gate for every route except `/login` and `/api/auth/*` — it would reject TikTok's unauthenticated webhook POSTs. |
| 7 | Secrets / env conventions | Plain `process.env.*` read in server code; `.env*` is git-ignored; no `.env.example` today. Names: `AMORUH_REDIS_URL/TOKEN`, `SITE_PASSCODE`, `AUTH_COOKIE_SECRET`, `ANTHROPIC_API_KEY`, `BLOB_READ_WRITE_TOKEN`. Production secrets live in Vercel (Sensitive vars cannot be read back). |
| 8 | External integrations | Anthropic API (invoice extraction), Vercel Blob, `open.er-api.com` (FX rates, cached in Redis). No third-party webhooks or OAuth today. |
| 9 | Where TikTok code should live | New isolated folder `src/lib/tiktok/` (client, signing, auth, shops, orders, webhooks, types, errors, config, store) + thin route handlers in `src/app/api/tiktok/*` + one admin page `src/app/admin/tiktok` (or `/integrations/tiktok`). No TikTok HTTP calls in components or in `sales-analytics`/`live-db`. |
| 10 | Architectural risks | (1) **Passcode gate vs webhook** — needs a narrow, explicit exemption for `/api/tiktok/webhook` only, authenticated by HMAC. (2) **Shared prod/dev Redis** — OAuth refresh tokens may rotate, so two environments refreshing would invalidate each other; tokens must exist in exactly one environment (prod), and dev must use a separate key prefix/database and a TikTok *Development Shop*. (3) **No scheduler** — reconciliation needs Vercel Cron (plan limits TO CONFIRM). (4) **Upstash command quota** was exhausted twice before (see `events/route.ts` comments) — sync must be frugal (batch reads, `MGET`, small pages). (5) **Single-array patterns** (`amoruh:products`) don't scale — TikTok data must use one key per order + zset indexes, never a growing array. (6) Webhook handler must answer **HTTP 200 within 3 seconds** — heavy work has to run after the response. |

---

## B. TikTok setup checklist (what **you** must do) and what Claude can do

### Developer model (verified)
TikTok Shop defines three developer types; ours is **"TikTok Shop seller developer — Custom app — own credentials only, your own shop's data only."** Public apps are for ISVs serving many sellers. (tts-developer-types)

### Manual steps for you in Partner Center

**Before you start (gating checks)**
1. Confirm the TikTok Shop seller account is **activated, has passed KYB (business) or KYC**, and has an **Account Manager bound** — this is a stated prerequisite. (developer-onboarding)
2. Confirm eligibility for Seller Developer registration: GKA, **AM or SKM** eligibility. A US local seller without one of these gets error 36010071. (seller-developer-onboarding-onepager) → **Ask your TikTok Account Manager to confirm AMORUH is eligible/allow-listed if registration is unavailable.**
3. Use the **same email** you used to register the TikTok Shop. (developer-onboarding)
4. Use the correct Partner Center: **US local seller with a US business license → `https://partner.us.tiktokshop.com`**; everything else → `https://partner.tiktokshop.com`. (seller-developer-onboarding-onepager; developer-onboarding)

**Register**
5. Log in to Partner Center with your Seller Center account → business guide → **"For TikTok Shop Seller" → Start Business**.
6. Pick the target market (**United States**) and business category **"TikTok Shop Seller"** (seller in-house developer). Verify the seller account; a "TikTok Shop seller" tag appears on My Account when done.
7. Start/answer the **compliance & legal review** if Partner Center asks (the docs say it is *always required for US and UK partners* and can take **3+ weeks**; whether it applies to seller developers is **TO CONFIRM** — start the parallel conversation with partner.us@tiktokshop.com early). (developer-onboarding)

**Create the app** (App & Service → Create app & service)
8. **App type: Custom.**
9. **Service category: "TikTok Shop Seller"** (not Connector — Connector apps additionally require app review + beta). Default name: e.g. **"AMORUH Internal Operations"**. Logo optional.
10. **Market: United States. Seller type: Local** (unless your shop is cross-border — confirm in Seller Center).
11. Toggle **Enable API ON.**
12. **Redirect URL:** `https://amoruh.com/api/tiktok/oauth/callback` (we will implement this route; it will sit behind the existing passcode gate, so only a logged-in AMORUH operator can complete a connection).
13. **Webhook URL:** `https://amoruh.com/api/tiktok/webhook` — must be **https, a domain name, no custom port, TLS ≥ 1.2**, and must return HTTP 200 within 3 seconds. (configuration-guide) *(Leave it blank at creation if our route isn't deployed yet; set it later under App & Service → your app → Basic Information → Developing → Webhook URL.)*
14. **Trusted domains:** I found **no "trusted domain" setting** in the current official docs. The only URLs are the Redirect URL and Webhook URL. If your Partner Center shows a trusted-domain field, tell me what it says.
15. Click **Create**. On the app details page note the **App Key** (public) and **App Secret** (private) and the **Service ID** (used for the authorize link).
16. **API scopes** (Manage API): enable only **Shop Authorized Information** and **Order Information**. Do **not** enable fulfillment, inventory, product-modify, finance, return/refund or promotion scopes in Phase 1 (extra scopes also slow review and lower authorization rates). (access-scope; authorization-overview-202407)
17. **Webhook topics:** subscribe to **Order status change (`ORDER_STATUS_CHANGE`)**, **Seller deauthorization (`SELLER_DEAUTHORIZATION`)** and **Upcoming authorization expiration (`UPCOMING_AUTHORIZATION_EXPIRATION`)**. (tts-webhooks-overview)
18. **Publish the custom app** — registration review first (timing varies). Publishing generates the **Authorize link**. (publish-custom-app) We are one seller, so the 25-authorization review trigger does not apply.

**Authorize our own shop**
19. While logged in to Seller Center **and** AMORUH, open the Authorize link (`https://services.us.tiktokshop.com/open/authorize?service_id=<your service id>` for the US). Approve the requested scopes.
20. TikTok redirects the browser to our Redirect URL with `?code=…&state=…`. The `auth_code` is **single-use and expires in 30 minutes**; our callback exchanges it immediately.

**Development Shop (recommended before touching the real shop)**
21. Development Kits → Development Shops → Create test account → **Core Function** (no KYB needed; orders can be generated without payment; **does not support finance/settlements**). Authorize the test app against it. The US is a supported market, and your app's market/seller type must match the sandbox's. (seller-center-development-shops)

### What Claude can implement (after you approve)
Everything in `src/lib/tiktok/`, the callback and webhook routes, the signed client, token storage/refresh, the diagnostic endpoint, the read-only order importer, the admin status page, tests with fixtures, `.env.example`, and written Vercel setup docs.

### What only you can do
All Partner Center clicks above, the Authorize-link consent, entering the App Key/Secret **directly into Vercel** (never in chat, code or Git), calling your Account Manager if registration is blocked, and configuring the webhook topics.

---

## C. Credentials and scopes

### Credentials (exact names from the docs → proposed env var names)
| TikTok name | Where it comes from | Secret? | AMORUH storage |
|---|---|---|---|
| `app_key` | Partner Center app page | no (public id) | env `TIKTOK_SHOP_APP_KEY` |
| `app_secret` | Partner Center app page | **yes** | env `TIKTOK_SHOP_APP_SECRET` (Vercel *Sensitive*) |
| `service_id` | app page | no | env `TIKTOK_SHOP_SERVICE_ID` (builds the authorize link) |
| `access_token` (7-day default life) | Get Access Token | **yes** | **Redis, encrypted** (rotates) |
| `refresh_token` (lifetime = authorization duration the seller granted) | Get Access Token | **yes** | **Redis, encrypted** |
| `shop_cipher`, `shop id` | `Get Authorized Shops` | not secret but treat as sensitive | Redis (connection record) |
| webhook secret | — | — | **none exists**: webhooks are signed with `app_secret` |
| (ours) token-encryption key | generated by us | **yes** | env `TIKTOK_TOKEN_ENCRYPTION_KEY` (32 random bytes) |
| (ours) cron auth | Vercel cron | yes | env `CRON_SECRET` |
| (ours) environment tag | — | no | env `TIKTOK_ENV` = `production` \| `dev` (selects Redis key prefix) |

I deliberately dropped `TIKTOK_SHOP_ACCESS_TOKEN`, `TIKTOK_SHOP_REFRESH_TOKEN`, `TIKTOK_SHOP_ID`, `TIKTOK_SHOP_CIPHER` and `TIKTOK_SHOP_WEBHOOK_SECRET` from your list: tokens/cipher change at runtime and the webhook secret doesn't exist. (A one-time bootstrap env var for tokens is possible if you prefer, but tokens would then go stale in 7 days.)

### Scopes — Phase 1 (minimum)
| Scope key (display name) | Why | Used by | Access |
|---|---|---|---|
| `seller.authorization.info` (Shop Authorized Information) | Get our shop id, name, region, `shop_cipher` | Get Authorized Shops | read |
| `seller.order.info` (Order Information) | Read orders | Get Order List, Get Order Detail | read |

Both endpoints also accept the broader `seller.fs.order&fufillment.management` ("FS Order & Fulfillment Management") as an *alternative*; **we must not request it** because it includes fulfillment management. (get-order-list-202309, get-authorized-shops-202309)

### Explicitly **not** requested in Phase 1
Fulfillment Basic, Package Split And Combine, Update Delivery Status, Logistics Basic, Product Basic/Modify/Delete, Return & Refund Basic, Finance Information, Promotion *, Global *, any analytics scope.

### Phase 2/3 candidates (research only — exact scope keys **TO CONFIRM** in each API reference)
Inventory read (likely under Product Basic), `seller.finance.info` (Finance Information — confirmed for Get Payments), Fulfillment Basic / Package Split And Combine, Logistics Basic.

---

## D. Proposed Phase 1 APIs

All endpoints use host **`https://open-api.tiktokglobalshop.com`**; token endpoints use **`https://auth.tiktok-shops.com`**. Common requirements for 202309+ APIs: query `app_key`, `sign`, `timestamp` (10-digit seconds, valid window **now − 5 min … now + 30 s**), header `x-tts-access-token`, header `content-type: application/json`, and `shop_cipher` where required. (common-parameters)

| Purpose | Method + path | Version | Scope | Risk |
|---|---|---|---|---|
| Exchange authorization code | `GET auth.tiktok-shops.com/api/v2/token/get` (`app_key, app_secret, auth_code, grant_type=authorized_code`) | v2 | — | credential exchange; **`authorized_code` is intentional, not `authorization_code`** |
| Refresh token | `GET auth.tiktok-shops.com/api/v2/token/refresh` (`grant_type=refresh_token`) | v2 | — | credential; must be single-flight |
| Authorized shops + cipher | `GET /authorization/202309/shops` | 202309 | `seller.authorization.info` | read |
| Order list (backfill + reconcile) | `POST /order/202309/orders/search` (**POST but read-only**; query `page_size` 1–100, `page_token`, `sort_field` `create_time`/`update_time`, `shop_cipher`; body filters `create_time_ge/lt`, `update_time_ge/lt`, `order_status`, `shipping_type`, …) | 202309 (latest shown) | `seller.order.info` | read |
| Order detail (hydrate, ≤ 50 ids/call) | `GET /order/202507/orders?ids=…&shop_cipher=…` (202309 also available) | 202507 | `seller.order.info` | read |
| Webhook inspection (status page only) | `GET /event/202309/webhooks` | 202309 | to confirm | read |

**Deliberately excluded:** `PUT/DELETE /event/202309/webhooks` (they change TikTok-side configuration). I recommend configuring the webhook URL/topics **manually in Partner Center** so the integration stays strictly read-only toward TikTok.

**Version policy:** versions live in one file (`src/lib/tiktok/config.ts`). Per TikTok, versions are assigned per API, new versions ship monthly, the old version stays available ≥ 2 months and retirement is announced ≥ 2 months ahead; the signing path must include the version exactly as in the reference (e.g. `/order/202507/orders`). (api-versioning)

**Request signing** (verified, sign-your-api-request): take all query params except `sign` and `access_token`, sort keys alphabetically, concatenate `{key}{value}`, prepend the request **path**, append the **raw body** (unless `multipart/form-data`), wrap with the app secret on both ends (`secret + string + secret`), then **HMAC-SHA256 keyed with the app secret → lowercase hex**. The access token is not part of the signature for 202309+.

**Errors/limits:** every response has `code` (0 = success), `message`, `request_id` (we log it). Rate limits are *dynamic* (per App × shop); docs suggest starting ~3–10 req/s for standard reads, backing off on HTTP 429 / error **36009002**, with exponential backoff + jitter; invalid timestamp → **36009004**. (rate-limits, common-parameters)

---

## E. Data model proposal (does **not** touch SaleRecord)

All keys are new, prefixed `amoruh:tiktok:{env}:` (`env` = `production` | `dev`). One key per record; indexes are zsets/sets — no growing arrays.

```
amoruh:tiktok:{env}:connection                 (JSON) shopId, shopName, region, sellerName, shopCipher,
                                                       grantedScopes[], userType, accessTokenEnc, accessExpiresAt,
                                                       refreshTokenEnc, refreshExpiresAt, connectedAt, status
amoruh:tiktok:{env}:token_lock                 (string, NX+EX) single-flight refresh lock
amoruh:tiktok:{env}:order:{orderId}            (JSON) normalized order (below)
amoruh:tiktok:{env}:orders_by_update           (zset, score = TikTok update_time)  — reconcile cursor + newest-order lookup
amoruh:tiktok:{env}:orders_by_create           (zset, score = create_time)
amoruh:tiktok:{env}:orders_by_room:{roomId}    (set of orderIds) — Phase 2 matching to TikTok LIVE sessions
amoruh:tiktok:{env}:orders_by_sku:{skuId}      (set of orderIds) — Phase 2 matching/inventory (created lazily)
amoruh:tiktok:{env}:webhook:seen:{notifId}     (string, SET NX EX 14d)  — dedupe
amoruh:tiktok:{env}:webhook:events             (capped list, ≤ 200)     — safe metadata only
amoruh:tiktok:{env}:sync_state                 (JSON) lastSuccessAt, lastWindow, lastError[], counts, requestIds
```

**Normalized order** (`schemaVersion: 1`):
`orderId, status, orderType (e.g. AUCTION), paymentStatus (if returned), createTime, updateTime, shippingType, deliveryOption {id,name}, fulfillmentType, isOnHold, splitOrCombineTag, autoCombineGroupId, packageIds[], trackingNumber(s), lineItems[]`, plus `syncedAt, source ('list'|'detail'|'webhook'), rawUpdateTime` for last-writer-wins.
**Line item:** `lineItemId, productId, skuId, sellerSku, productName, skuName, quantity (derived — **TO CONFIRM** whether TikTok returns one line per unit), salePrice, originalPrice, platformDiscount, sellerDiscount, currency, roomId, packageId, displayStatus`.

**Deliberately NOT stored:** buyer name, phone, email, recipient address/postal code, payment card data. `buyer_nickname` and a buyer id would help Phase 2 auction matching but are personal identifiers — **your decision (see I-7)**; default: not stored.

**Relationship to AMORUH (Phase 2, not now):** `AMORUH LIVE Sale ↔ TikTok order line` will be a separate mapping record (`amoruh:tiktok:{env}:match:{lineItemId}` → saleId + confidence + method), never edits to `SaleRecord`.

---

## F. Security plan

- **Secrets:** `app_secret` and the encryption key only in Vercel env (Sensitive), never in code/Git/logs/responses. `.env.example` lists names only. **Tokens only in Redis, AES-256-GCM encrypted** with `TIKTOK_TOKEN_ENCRYPTION_KEY`; decrypted in memory per request.
- **Single environment holds tokens.** Production only. Local dev/preview use `TIKTOK_ENV=dev` (separate key prefix) with a **Development Shop + test app**, and a guard that refuses to start the production-token path outside `production`.
- **Token refresh:** refresh when the access token has < 24 h left (default life 7 days) or on a 401/expired-token error; use the Redis lock so only one request refreshes; persist the *returned* refresh token every time (we cannot assume it never rotates — **TO CONFIRM**); if refresh fails, mark the connection `needs_reauthorization` and surface it on the status page. Refresh token lifetime = the authorization duration; `UPCOMING_AUTHORIZATION_EXPIRATION` arrives 30 days ahead and daily until reauthorized; `SELLER_DEAUTHORIZATION` stops all calls and clears the connection.
- **OAuth callback:** behind the existing passcode gate; `state` is a single-use random value stored in Redis and validated on return (TikTok recommends this); `auth_code` exchanged server-side immediately; `grant_type` exactly `authorized_code`.
- **Webhook validation:** read the **raw body** (`await req.text()`), compute `HMAC-SHA256(app_key + rawBody, app_secret)` as lowercase hex, **constant-time compare** to the `Authorization` header (no "Bearer"), reject missing/mismatch with **401**, only then parse JSON. Look up `shop_id` against our connection; unknown shop → log and 200. Egress IP allow-listing is *optional*; we won't depend on it (TikTok added SG/EU ranges Aug 30, US unchanged).
- **Idempotency:** `SET NX` on `tts_notification_id` (fallback key: type+shop+timestamp+order id); duplicates return 200 without work. Order upserts are keyed by `orderId` and ignore any record whose `update_time` is older than the stored one. Phase 1 never touches inventory or money, so duplicate processing cannot cause financial effects.
- **PII & logging:** a central redaction helper; logs contain only `request_id`, endpoint name, status code, TikTok `code`, durations, counts — never tokens, secrets, buyer fields, or request/response bodies. Because TikTok only returns unmasked buyer data to certain app categories (our category, "TikTok Shop Seller", is one of them since Oct 12, 2026), we will project the response into our schema **immediately** and discard the rest.
- **Exposure:** status page and diagnostic endpoint sit behind the passcode gate and return booleans/ids/timestamps only. The webhook route is the *only* gate exemption and is HMAC-authenticated.
- **Read-only guard:** the TikTok client exposes only an allow-list of read operations (token, shops, order search, order detail, get-webhooks); any other method/path throws before a network call. A unit test enforces it.

---

## G. Synchronization plan

1. **Connect:** callback → token exchange → `Get Authorized Shops` → store connection (shop id, name, region, cipher, scopes). Diagnostic endpoint re-verifies it on demand.
2. **Initial backfill (operator-triggered, default 7 days, configurable):** `POST /order/202309/orders/search` with `create_time_ge = now − 7d`, `sort_field=update_time`, `page_size=100`, follow `next_page_token` until exhausted; hydrate in batches of ≤ 50 ids with `GET /order/202507/orders`; upsert normalized orders; write counts + `request_id`s to `sync_state`. Hard cap on pages per run; resumable cursor so it fits Vercel's 60 s limit.
3. **Webhook (near-real-time trigger):** verify → dedupe → store safe metadata → return **200 immediately**; then (using `after()`/background execution) fetch `Order Detail` for the event's `order_id` and upsert. Failures never block the response.
4. **Reconciliation (the safety net — TikTok explicitly says not to rely on webhooks alone):** a Vercel Cron job every 10–15 minutes calls the importer with `update_time_ge = lastSuccessfulSync − 10 min overlap`; idempotent upserts make the overlap safe. A once-daily wider sweep (last 48 h) catches anything older. Cron endpoint requires `CRON_SECRET`. **Vercel plan limits for cron frequency are TO CONFIRM (Hobby = daily only).** If cron is limited, the fallback is operator-pressed "Sync now" plus an on-load stale check.
5. **Failure handling:** retry only on timeouts, HTTP 5xx and throttling (429 / 36009002) with exponential backoff + jitter and a retry cap; never retry 401 blindly (refresh once, then stop); malformed responses are rejected by a schema check and recorded (code + `request_id`, no payload).

---

## H. Phase roadmap

| Phase | Scope |
|---|---|
| **1 (this report)** | Partner Center app + OAuth connection + diagnostic + read-only order backfill/reconcile + webhook receiver (idempotent, minimal) + status page + tests. |
| **2** | AMORUH LIVE Sale ↔ TikTok order-line matching (separate mapping, using `room_id`, `order_type=AUCTION`, price, SKU/seller SKU, timestamps, buyer nickname if approved) + inventory *mirror/reconciliation* (read-only reports first; no automatic AMORUH inventory edits). |
| **3** | Fulfillment (packages, combined shipping, labels, tracking) + Finance reconciliation → true net profit → feed Reorder Intelligence. |
| **4** | Automation / AI business assistant. |

### Step 11 — Inventory webhook research (no activation)
- **Event:** *Inventory Changed by Shop* — webhook **type 71**, announced 2026-09-16, all markets. Covers order creation/cancellation/shipment, manual Seller Center adjustments, OpenAPI updates, marketing-campaign/creator-collaboration lock/release and automatic replenishment. (changelog entry nn6csp5o)
- **Payload (per TikTok):** shop/product/SKU ids; **post-change snapshot** (`quantity_snapshot_after_change`: total, available, committed, in-shop, locked for campaigns/creator collaborations); **`change_detail[]`** with trigger source, occurrence time and per-category quantity deltas; **`event_id`** (event-level dedupe) and **`idempotency_key`** (per-change dedupe).
- **Recommended AMORUH design:** (1) build an explicit **mapping table** `tiktok sku_id / seller_sku ↔ AMORUH productId` (barcode/SKU match proposes, an operator confirms; never fuzzy-auto-link). (2) Keep a **read-only mirror** `tiktokInventory[skuId]` from the **snapshot** (authoritative, last-event-wins by occurrence time) and store `change_detail` **only as an audit trail** — **never apply both** the snapshot and the deltas to the same balance. (3) Dedupe on `event_id` and each change's `idempotency_key`. (4) Treat categories separately: *available* is what is sellable; *committed* = reserved by open orders; *campaign-locked* is not sellable; don't collapse them. (5) Surface mismatches between TikTok *available* and AMORUH lot-ledger stock as a **reconciliation report**; AMORUH's lot ledger (cost basis!) stays the source of truth — TikTok data must not auto-edit `Product.inventory`. (6) Manual Seller Center adjustments and OpenAPI updates arrive as triggers and need an operator review queue, not automatic mirroring into AMORUH lots.

### Step 12 — Fulfillment research (no implementation)
We process 70+ package LIVEs with several TikTok orders combined into one box, so the model must be **many orders/lines ↔ many packages**, never "1 order = 1 box". Official APIs/fields found:
- **Order fields:** `packages[]`/package ids on orders, `split_or_combine_tag`, **`auto_combine_group_id`** (orders sharing a value should ship together; N/A if the seller opted out), `warehouse_id`, `room_id`.
- **Combination is a recommendation, not automatic** (US Automated Order Combination, published 2026-05-05): the seller must accept/reject; eligible Shop-tab/Video/LIVE orders with the same buyer, address, seller and warehouse are auto-grouped in a time window if enabled in Seller Center.
- **3PL (Seller Shipping):** combine physically, then **use the same tracking number** on every order via *Mark Package As Shipped* or *Ship Package*.
- **4PL (TikTok Shipping):** *Create Packages* **`POST /fulfillment/202512/packages`** (version **v202512+**) with `ship_type: "3"`, a primary `order_id` and `order_list_ids[]` for the other orders → one shipping label. Package split/combine also exist (scope "Package Split And Combine"). The `PACKAGE_UPDATE` webhook fires when packages are combined/split.
- **Other relevant pieces:** Get Package Detail, Search Packages, Get Package Shipping Document, Get Shipping Providers (don't hard-code ids), `ON_HOLD` order status, `PARTIALLY_SHIPPING` status (one order → multiple packages is supported), the US "TikTok Shipping label allocation" and "POP USPS label restriction" notices and a 72-hour US shipping-info update window (**changelog titles seen; not yet read in detail**), and US hazmat fee fields in Finance (below). Hazmat product-attribute requirements exist in the Product API (**not reviewed in depth** — fragrances are typically hazmat, so Phase 3 should read these first).
- **Not readable by me:** the "Order Sync guide" and "Fulfillment guide" are Feishu/Lark documents linked from the solution-guide hub; they require login/rendering I couldn't access. Recommend you (or I, if you open them) read them before Phase 3.

### Step 13 — Finance research (no implementation) → Phase 3 recommendation
Goal: `sale price − merchandise cost − TikTok referral fees − shipping/fulfillment fees ± discounts/subsidies − refunds = net profit`.
- **Scope:** `seller.finance.info` (Finance Information); finance data is available in **Development Shops only for Full Function accounts**.
- **APIs (versions as of the changelog):** `GET /finance/202501/orders/{order_id}/statement_transactions` (per order, SKU-level `sku_transactions`), `GET /finance/202501/statements/{statement_id}/statement_transactions`, `GET /finance/202507/orders/unsettled`, Get Statements, `GET /finance/202605/payments` (**202309 sunset 2026-08-15**; `reserve_amount` removed) and withdrawals. Statement/Order-statement v202309 was retired 2025-07-01.
- **What the 202501 schema gives:** `revenue_amount` + breakdown, `shipping_cost_amount` + breakdown (incl. **US `hazmat_noncompliance_fee`, `hazmat_handling_fee`, `non_standard_weight_fee`, `non_standard_dimension_fee`** — added 2026-10-23), `fee_tax_amount` split into `fee` and `tax` objects (referral/commission etc. — exact field names **TO CONFIRM** from the endpoint page), `supplementary_component` (platform discounts, incentives, sales tax, retail delivery fee), `settlement_amount`, adjustments.
- **Recommendation:** a *Phase 3 (finance)* that (1) ingests per-order statement transactions after settlement, (2) stores a `tiktokOrderFinance` record per order line (never overwriting AMORUH's `landedCostAtSale`), (3) computes **actual net profit = TikTok settlement − AMORUH historical cost snapshot**, (4) feeds that into Reorder Intelligence as an optional "net of TikTok fees" view, and (5) reconciles statement totals to bank payments via Get Payments. Handle refunds/returns through the Return & Refund scope later.

### Step 14 — Versioning and 2026 breaking changes relevant to us
Versions are centralized in `src/lib/tiktok/config.ts` (never in call sites). Items from the changelog that matter:
| Date | Change | Impact |
|---|---|---|
| 2026-10-12 | **Buyer personal info masked by App Category** (Get Order List/Detail, Get Package Detail) | Our category "TikTok Shop Seller" receives unmasked data; we still don't store it. If category is wrong we would silently get masked values. |
| 2026-10-22 | `room_id` (LIVE session id) and `buyer_nickname` on order line items — UK/EU/SEA/LATAM/JP; **US `room_id` since 2026-07-08** | Phase 2 matching key. |
| 2026-10 | New order tags (`authentication_required`, `is_refundable_sample`, `is_subscription_order`) and `order_type = AUCTION` (Get Order Detail 202507 only) | Parser must tolerate new enum values; `AUCTION` = LIVE auction orders. |
| 2026-09-16 | Inventory Changed by Shop webhook (type 71) | Phase 2. |
| 2026-06-15 | Get Payments 202309 → 202605 (sunset 2026-08-15) | Phase 3 must use 202605. |
| 2026-05-05 | Automated Order Combination + Create Packages v202512 | Phase 3. |
| 2026-10 | Analytics: query-window limits and endpoint retirements (Nov 6 / Dec 28); "New APIs for TikTok LIVE" (Shop Live Performance Overview/List) | Not needed in Phase 1; optional later source for LIVE session ids. |
| 2026-08/09 | Webhook egress IP additions (SG/EU; US unchanged) | Only matters if we IP-allowlist (we won't). |
| 2025-03 | `auto_combine_group_id`/Auto Combine Order ID for LIVE orders | Phase 3. |

---

## I. Questions / blockers (need your answers before coding)

1. **Seller-developer eligibility (critical):** Does AMORUH have a TikTok Shop **Account Manager** (or GKA/SKM status)? Without it, registration may fail with error 36010071. Is the Seller Center account **KYB-verified** and a **US local** shop (not cross-border)?
2. **Who can register?** The Partner Center login must use the *same email* as the shop, and the account owner must be able to complete verification.
3. **Compliance/legal review:** Does Partner Center require the 3+ week review for our seller-developer registration? (Docs say always for US/UK partners.) If yes, we should start it immediately — Phase 1 live testing depends on it. Until then we can build and unit-test everything with fixtures.
4. **Development Shop:** OK to create a **Core Function** test shop + use a *separate test app* for local development so no production tokens ever touch dev?
5. **Redis isolation:** Local dev currently uses the production Redis. For TikTok data, OK to use the `amoruh:tiktok:{env}:` prefix, and (better) give local dev its own Upstash database before we start?
6. **Vercel plan:** Hobby or Pro? (Cron minimum interval and function limits differ.) And the Upstash plan/quota for the extra reconcile traffic.
7. **PII decision:** Allowed to store `buyer_nickname` (TikTok username — useful to match LIVE auction winners in Phase 2), or keep Phase 1 strictly free of any buyer identifier? Default: don't store.
8. **Webhook configuration:** OK to configure webhook URL/topics **manually** in Partner Center (keeps us strictly read-only toward TikTok) instead of via the Events API?
9. **Domain:** Confirm `https://amoruh.com` is the canonical production domain for the Redirect URL and webhook URL (no `www`, no custom port).
10. **Backfill window and cadence:** Keep 7 days / reconcile every 15 min if cron allows?
11. **Admin page location & access:** `/admin/tiktok` behind the existing passcode — acceptable, or add the same "operator" label convention used in Go Live?

### Things I could **not** verify (please keep in mind)
- The **response field list of Get Order Detail/List** is collapsed in the web docs I could read. Field names above come from the changelog entries I read (`room_id`, `buyer_nickname`, `order_type`, `auto_combine_group_id`, `split_or_combine_tag`, `warehouse_id`, `line_items[].id/product_name/sku_name/display_status`, `is_on_hold_order`). Exact names/types for price, discount, seller SKU, package and tracking fields will be pinned **from a real Development-Shop response (saved as a fixture)** in Phase 1 step 1, before the importer is finalized.
- Whether TikTok returns **one line item per unit** (affects quantity) — confirm with the first real order.
- Whether the **refresh token rotates** on refresh — we'll store whatever is returned.
- Exact scope keys for inventory read, fulfillment, and the Events API — to be confirmed in Partner Center → Manage API.
- The two Lark-hosted solution guides (Order Sync / Fulfillment) — not readable here.

---

## Official sources used (TikTok Shop Partner Center, accessed 2026-11-04)

- Create your App — https://partner.tiktokshop.com/docv2/page/create-your-app
- Developer types / Get started — https://partner.tiktokshop.com/docv2/page/tts-developer-types
- Developer onboarding — https://partner.tiktokshop.com/docv2/page/developer-onboarding
- Seller developer onboarding one-pager — https://partner.tiktokshop.com/docv2/page/seller-developer-onboarding-onepager
- Create a TikTok Shop app (OAuth client) — https://partner.tiktokshop.com/docv2/page/create-tts-app-oauth-client
- Publish a custom App — https://partner.tiktokshop.com/docv2/page/publish-custom-app
- Authorization overview (token get/refresh, domains) — https://partner.tiktokshop.com/docv2/page/authorization-overview-202407
- Access scope — https://partner.tiktokshop.com/docv2/page/access-scope
- Sign your API request — https://partner.tiktokshop.com/docv2/page/sign-your-api-request
- Common parameters — https://partner.tiktokshop.com/docv2/page/common-parameters
- Rate limits — https://partner.tiktokshop.com/docv2/page/rate-limits
- API versioning — https://partner.tiktokshop.com/docv2/page/api-versioning
- Get Authorized Shops (202309) — https://partner.tiktokshop.com/docv2/page/get-authorized-shops-202309
- Get Order List (202309) — https://partner.tiktokshop.com/docv2/page/get-order-list-202309
- Get Order Detail (202507) — https://partner.tiktokshop.com/docv2/page/get-order-detail-202507
- Webhooks overview (signature, retry, topics) — https://partner.tiktokshop.com/docv2/page/tts-webhooks-overview
- Webhook configuration guide — https://partner.tiktokshop.com/docv2/page/configuration-guide
- Seller Center development shops — https://partner.tiktokshop.com/docv2/page/seller-center-development-shops
- Orders and Fulfillment API Solution Guide (hub) — https://partner.tiktokshop.com/docv2/page/solution-guidance-orders-fulfillment-api
- Changelog — https://partner.tiktokshop.com/docv2/page/changelog
  - Order APIs add LIVE Session ID and Buyer Nickname — https://partner.tiktokshop.com/docv2/page/gfhiex0q
  - US `room_id` in Order APIs — https://partner.tiktokshop.com/docv2/page/07r6ldtn
  - Auto Combine Order ID for LIVE sessions — https://partner.tiktokshop.com/docv2/page/auto-combine-order-id-available-in-order-details-for-live-sessions
  - Automated Order Combination — ISV guide — https://partner.tiktokshop.com/docv2/page/lm9400zu
  - Inventory Changed by Shop webhook — https://partner.tiktokshop.com/docv2/page/nn6csp5o
  - Buyer Personal Information Masking — https://partner.tiktokshop.com/docv2/page/pgd9hfyy
  - Webhook Egress IP Update — https://partner.tiktokshop.com/docv2/page/iuhsev4x
  - Get Payments 202309 → 202605 — https://partner.tiktokshop.com/docv2/page/p48h74af
  - Statement Transactions v202501 — https://partner.tiktokshop.com/docv2/page/new-version-v202501-for-statement-transactions-and-order-statement-transactions
  - Finance API updates (fees/taxes) — https://partner.tiktokshop.com/docv2/page/62g4f932
  - New APIs for TikTok LIVE — https://partner.tiktokshop.com/docv2/page/sv0xa2r6
  - 2026 October API Updates Summary — https://partner.tiktokshop.com/docv2/page/pcr7j9rd
