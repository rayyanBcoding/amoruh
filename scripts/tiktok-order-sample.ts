// Milestone 1: fetch a SMALL read-only sample of recent TikTok orders and print a
// SANITIZED view so we can inspect the real API fields. Nothing is written to the
// AMORUH catalog / sales ledger / inventory, and nothing is written to TikTok.
//
//   npx tsx scripts/tiktok-order-sample.ts [count 1-10]
//
// Uses the DEV connection (amoruh:tiktok:dev:*) created by the OAuth callback.
// Raw responses stay in memory; only the sanitized report is printed and saved to
// the git-ignored .tiktok-samples/ folder.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

for (const f of [".env.development.local", ".env.local"]) {
  if (existsSync(f)) process.loadEnvFile(f); // existing vars win, so load the higher-priority file first
}

async function main() {
  if (process.env.VERCEL_ENV) throw new Error("Refusing to run with VERCEL_ENV set — this sample script is for the local DEV connection only.");

  const { getValidAccessToken } = await import("../src/lib/tiktok/auth");
  const { getAuthorizedShops } = await import("../src/lib/tiktok/shops");
  const { getOrderDetails, orderIdOf, searchRecentOrders, SAMPLE_MAX } = await import("../src/lib/tiktok/orders");
  const { keyPaths, sanitize } = await import("../src/lib/tiktok/sanitize");
  const { TIKTOK_ENV } = await import("../src/lib/tiktok/config");

  const count = Math.min(Math.max(Number(process.argv[2] ?? 5) || 5, 1), SAMPLE_MAX);
  console.log(`TikTok env: ${TIKTOK_ENV} — fetching up to ${count} recent orders (read-only)\n`);

  const { accessToken, conn } = await getValidAccessToken();
  const shops = conn.shops.length ? conn.shops : (await getAuthorizedShops(accessToken)).shops;
  const shop = shops[0];
  if (!shop?.cipher) throw new Error("No authorized shop (with a shop cipher) found for this connection.");
  console.log(`Shop: ${shop.name || "(unnamed)"} · region ${shop.region} · id ${shop.id} · cipher <present, not printed>`);

  const search = await searchRecentOrders({ accessToken, shopCipher: shop.cipher, pageSize: count });
  const ids = search.orders.map(orderIdOf).filter((x): x is string => !!x);
  console.log(`Order search: ${search.orders.length} returned (total_count ${search.totalCount ?? "n/a"}) · request_id ${search.requestId}`);

  const detail = await getOrderDetails({ accessToken, shopCipher: shop.cipher, orderIds: ids });
  console.log(`Order detail: ${detail.orders.length} returned · request_id ${detail.requestId}\n`);

  const report = {
    generatedAt: new Date().toISOString(),
    env: TIKTOK_ENV,
    searchShape: keyPaths(search.orders),
    detailShape: keyPaths(detail.orders),
    searchSanitized: sanitize(search.orders, "orders"),
    detailSanitized: sanitize(detail.orders, "orders"),
  };

  mkdirSync(".tiktok-samples", { recursive: true });
  const file = join(".tiktok-samples", `order-sample-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));

  console.log("=== Order DETAIL — key paths & types (no values) ===");
  console.log(report.detailShape.join("\n"));
  console.log("\n=== Order DETAIL — sanitized ===");
  console.log(JSON.stringify(report.detailSanitized, null, 2));
  console.log(`\nSaved sanitized report to ${file}`);
}

main().catch((err) => {
  // Only TikTok's own code/message/request_id are safe to print.
  console.error("FAILED:", err instanceof Error && "describe" in err ? (err as { describe(): string }).describe() : err instanceof Error ? err.message : "unknown error");
  process.exit(1);
});
