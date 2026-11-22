// Hermetic tests: status fixture from the supplied export; no production access.
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { installFakeRedis } from "./support/fake-redis";
import batch from "../src/lib/data/catalog-live-enrichment.json";
import prior from "../src/lib/data/intake-live-enrichment.json";
import type { Product } from "../src/lib/types";
import type { RetailReference } from "../src/lib/retail-reference";

const fake = installFakeRedis();
const missingNotes = new Set(["p_1793929275147_w6tbpw", "p_1793929364458_cpfyok", "p_1793930267060_xrj6a6", "p_1795140971749_ry1e33", "p_1795140993558_66bgd2", "p_1795141112811_tbmj4t", "p_1795141472000_3el726", "p_1795142804527_hxvb9z", "p_1795143319042_cjvp1h", "p_1795143968653_fnzu0t", "p_1795144277685_4rr5jq", "p_1795144286702_gs8e62"]);
const verifiedIds = new Set(["p_1792271223674_lo2f21", "p_1792271309810_fy0ftj", "p_1793928518539_zwklf6", "p_1793929775824_sirhzv", "p_1794532615083_lan9v6", "p_1795141506008_x5db3k", "p_1795142506810_ububu5", "p_1795142604856_hqgpkv", "p_1795142674226_6zllje", "p_1795142725966_0m89ff", "p_1795143066916_hmeq46", "p_1795143449211_yajuqu", "p_1795144568835_oaufog"]);

async function main() {
  const { planIntakeEnrichment } = await import("../src/lib/intake-live-enrichment");
  const { retailIdentity, retailReferenceError, isVerifiedRetail } = await import("../src/lib/retail-reference");
  const seed = (await import("../data/products.json")).default[0];
  const catalog = batch.map<Product>((row) => {
    const old = prior.find((r) => r.productId === row.productId);
    const p = { ...seed, ...row.identity, id: row.productId, inventory: 5, cost: 123, retailPrice: 999,
      topNotes: [], middleNotes: [], baseNotes: [], fragranceNotes: [], sellingKeyNotes: [],
      liveNotes: missingNotes.has(row.productId) ? undefined : {
        keyNotes: ["Keep"], vibe: "Existing", bestFor: "Existing", check: true,
        source: "manual" as const, updatedAt: "2026-11-21",
      },
      retailReference: old ? old.retailReference as RetailReference : undefined,
    } as Product;
    if (verifiedIds.has(p.id) && !isVerifiedRetail(p)) {
      p.retailReference = { ...row.retailReference, status: "verified", priceCents: 11200,
        referenceSize: "100 mL", retailer: "Official brand website",
        sourceUrl: p.brand === "Gucci" ? "https://www.gucci.com/" : p.brand === "Burberry" ? "https://us.burberry.com/" : "https://www.jeanpaulgaultier.com/",
        manuallyEdited: true,
      } as RetailReference;
    }
    return p;
  });
  assert.equal(batch.length, 177);
  assert.equal(new Set(batch.map((r) => r.productId)).size, 177);
  for (const row of batch) {
    assert.equal(row.retailReference.identityKey, retailIdentity(row.identity));
    assert.equal(retailReferenceError(row.retailReference, row.identity.brand), null);
  }
  const plan = (current: Product[]) => planIntakeEnrichment(current, batch);
  const out = plan(catalog);
  assert.equal(out.result.skipped, 0);
  assert.equal(out.result.newLiveNotes, 1);
  assert.equal(out.result.preservedLiveNotes, 165);
  assert.equal(out.result.notesUnresolved.length, 11);
  assert.equal(out.result.verifiedRetailReference, 12);
  assert.equal(out.products.filter((p) => isVerifiedRetail(p)).length, 25);
  assert.equal(out.products.filter((p) => !p.retailReference).length, 0);
  for (const [i, before] of catalog.entries()) {
    const after = out.products[i];
    const strip = (p: Product) => { const { liveNotes: _n, retailReference: _r, ...rest } = p; void _n; void _r; return rest; };
    assert.deepEqual(strip(after), strip(before));
    if (before.liveNotes) assert.deepEqual(after.liveNotes, before.liveNotes);
    if (verifiedIds.has(before.id)) assert.deepEqual(after.retailReference, before.retailReference);
  }
  assert.deepEqual(plan(out.products).products, out.products);
  assert.equal(plan(out.products).result.newLiveNotes, 0);
  assert.equal(plan(out.products).result.verifiedRetailReference, 0);
  const candidate = out.products.find((p) => p.id === batch.find((r) => r.liveNotes)?.productId)!;
  const changed = { ...candidate, barcode: "different" };
  assert.deepEqual(plan([changed]).products, [changed]);
  assert.deepEqual(plan([{ ...candidate, inventory: 0 }]).products, [{ ...candidate, inventory: 0 }]);
  const held = { ...candidate, liveNotes: { keyNotes: [], vibe: "", bestFor: "", source: "manual" as const, check: true, updatedAt: "2026-11-21" } };
  assert.equal(plan([held]).result.newLiveNotes, 0);
  const manual = { ...catalog[0], retailReference: { ...batch[0].retailReference, manuallyEdited: true } as RetailReference };
  assert.deepEqual(plan([manual]).products[0].retailReference, manual.retailReference);
  await fake.set("amoruh:products", catalog);
  process.env.SITE_PASSCODE = "test"; process.env.AUTH_COOKIE_SECRET = "test-secret";
  const { computeAuthToken } = await import("../src/lib/auth");
  const { GET, POST } = await import("../src/app/api/internal/intake-live-enrichment/route");
  const address = "http://localhost/api/internal/intake-live-enrichment?scope=catalog";
  assert.equal((await GET(new NextRequest(address))).status, 401);
  const cookie = `amoruh_auth=${await computeAuthToken()}`;
  const preview = await GET(new NextRequest(address, { headers: { cookie } }));
  const summary = await preview.json();
  assert.equal(summary.currentTotals.completeLiveNotes, 165);
  assert.equal(summary.currentTotals.verifiedRetailReferences, 13);
  assert.equal(summary.totals.completeLiveNotes, 166);
  assert.equal(summary.totals.unresolvedLiveNotes, 11);
  assert.equal(summary.totals.verifiedRetailReferences, 25);
  assert.equal(summary.totals.notVerifiedRetailReferences, 152);
  const response = await POST(new NextRequest(address, { method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ apply: true }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).totals.missingRetailRecords, 0);
  console.log("Catalog: 177 identities; 1 note fill, 12 verified fills; 166/11 notes and 25/152 references; exact identity, flags, protected fields, replay, preview totals and authenticated apply passed.");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
