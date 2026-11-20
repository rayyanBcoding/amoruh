// Hermetic route test: no real credentials, Redis, or production data.
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

async function main() {
  process.env.SITE_PASSCODE = "test-only";
  process.env.AUTH_COOKIE_SECRET = "inventory-export-test-only";
  const rows = [
    { id: "p1", brand: "Brand", name: "Scent set (100ml + 10ml)", concentration: "EDP", size: "100ml", condition: "Tester", inventory: 2, barcode: "123", sku: "sku", cost: 999, notes: "private", supplier: "private", tiktokListing: "private" },
    { id: "zero", inventory: 0 }, { id: "negative", inventory: -1 },
  ];
  let reads = 0;
  let failRead = false;
  globalThis.__amoruhRedis = new Proxy({}, {
    get(_t, key) {
      if (key === "then") return undefined;
      if (key === "get") return async (k: string) => {
        reads++;
        assert.equal(k, "amoruh:products");
        if (failRead) throw new Error("secret backend detail");
        return rows;
      };
      return () => { throw new Error(`Unexpected Redis operation: ${String(key)}`); };
    },
  }) as typeof globalThis.__amoruhRedis;
  const { GET } = await import("../src/app/api/internal/inventory-export/route");
  const { computeAuthToken } = await import("../src/lib/auth");
  const request = (token?: string) => new NextRequest("http://localhost/api/internal/inventory-export", {
    headers: token ? { cookie: `amoruh_auth=${token}` } : {},
  });
  assert.equal((await GET(request())).status, 401);
  assert.equal((await GET(request("invalid"))).status, 401);
  assert.equal(reads, 0);
  const token = (await computeAuthToken())!;
  const before = JSON.stringify(rows);
  const res = await GET(request(token));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.match(res.headers.get("content-disposition")!, /attachment/);
  const body = await res.json();
  assert.equal(body.count, 1);
  assert.deepEqual(body.products, [{ productId: "p1", brand: "Brand", productName: rows[0].name, concentration: "EDP", size: "100ml", condition: "Tester", stockQuantity: 2, barcode: "123", sku: "sku", giftSetContents: null }]);
  assert.equal(JSON.stringify(rows), before);
  failRead = true;
  const failed = await GET(request(token));
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "Could not export inventory." });
  console.log("Inventory export: auth, field allowlist, stock filter, no writes, headers and safe errors passed.");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
