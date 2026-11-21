// Hermetic: the real Redis Lua CAS executes in Fengari; no production access.
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { NextRequest } from "next/server";
import { installFakeRedis } from "./support/fake-redis";
import batch from "../src/lib/data/intake-live-enrichment.json";
import type { Product } from "../src/lib/types";
import type { RetailReference } from "../src/lib/retail-reference";

const fake = installFakeRedis();
async function main() {
  const { planIntakeEnrichment } = await import("../src/lib/intake-live-enrichment");
  const { updateCatalogMetadata } = await import("../src/lib/product-metadata-db");
  const { approvedRetailSource, retailReferenceError, isVerifiedRetail } = await import("../src/lib/retail-reference");
  const { RetailReferenceLine } = await import("../src/components/RetailReferenceLine");
  const seed = (await import("../data/products.json")).default[0];
  const existingNotes = new Set(["p_1788591590865_jr8hc4", "p_1791861342113_p4i915", "p_1791861342187_7623t2", "p_1792271223674_lo2f21", "p_1792271309810_fy0ftj", "p_1792286854524_7hr81p", "p_1793928518539_zwklf6", "p_1793929775824_sirhzv", "p_1794532542591_n9d5sp", "p_1794533167881_1f4f3y", "p_1794533191454_62u5v7"]);
  const catalog: Product[] = batch.map<Product>((row) => ({
    ...seed, status: "active", ...row.identity, id: row.productId, inventory: 5, cost: 123.45, retailPrice: 999,
    topNotes: [], middleNotes: [], baseNotes: [], fragranceNotes: [],
    liveNotes: existingNotes.has(row.productId) ? { keyNotes: ["Existing"], vibe: "Manual", bestFor: "Keep", source: "manual", check: true, updatedAt: "2026-01-01T00:00:00Z" } : undefined,
  }));
  const result = planIntakeEnrichment(catalog);
  assert.equal(result.result.newLiveNotes, 28);
  assert.equal(result.result.verifiedRetailReference, 13);
  assert.equal(result.result.notVerifiedRetailReference, 43);
  assert.equal(result.result.preservedLiveNotes, 11);
  assert.equal(result.result.notesUnresolved.length, 17);
  for (const p of catalog) {
    const updated = result.products.find((x) => x.id === p.id)!;
    const { liveNotes: _n, retailReference: _r, ...rest } = updated; void _n; void _r;
    const { liveNotes: _old, ...oldRest } = p; void _old;
    assert.deepEqual(rest, oldRest); // includes stock, cost, MSRP, identity and every existing field
    if (p.liveNotes) assert.deepEqual(updated.liveNotes, p.liveNotes);
    assert.equal(retailReferenceError(updated.retailReference, p.brand), null);
    if (updated.retailReference?.status === "verified") assert.equal(isVerifiedRetail(updated), true);
  }
  const replay = planIntakeEnrichment(result.products);
  assert.equal(replay.result.newLiveNotes, 0);
  assert.equal(replay.result.verifiedRetailReference, 0);
  assert.equal(replay.result.notVerifiedRetailReference, 0);
  assert.deepEqual(replay.products, result.products);
  const blocked = [{ ...catalog[0], name: "Different flanker" }];
  assert.equal(planIntakeEnrichment(blocked).result.skipped, batch.length);
  assert.deepEqual(planIntakeEnrichment(blocked).products, blocked);
  assert.equal(planIntakeEnrichment([{ ...catalog[0], inventory: 0 }]).result.skipped, batch.length);
  // Existing fallback notes and a check-before-quoting flag must not be replaced.
  const candidate = catalog.find((p) => batch.find((r) => r.productId === p.id)?.liveNotes)!;
  const fallback = { ...candidate, sellingKeyNotes: ["Existing fallback"] };
  assert.equal(planIntakeEnrichment([fallback]).result.newLiveNotes, 0);
  const flagged = { ...candidate, liveNotes: { keyNotes: [], vibe: "", bestFor: "", source: "ai_draft" as const, check: true, updatedAt: "2026-01-01" } };
  assert.equal(planIntakeEnrichment([flagged]).result.newLiveNotes, 0);
  // Preserve even an unverified manual correction.
  const manual = { ...candidate, retailReference: { ...batch[0].retailReference, manuallyEdited: true } as RetailReference };
  assert.equal(planIntakeEnrichment([manual]).result.preservedRetailReference, 1);
  for (const host of ["fragrancenet.com", "jomashop.com", "fragrancex.com", "maxaroma.com", "giftexpress.com", "nordstromrack.com", "nordstrom.com.evil.test"]) {
    assert.equal(approvedRetailSource("Nordstrom", `https://${host}/p`, "Burberry"), false);
  }
  assert.equal(approvedRetailSource("Official brand website", "https://us.afnan.com/products/9-pm", "Afnan"), true);
  assert.equal(approvedRetailSource("Official brand website", "https://us.afnan.com/products/9-pm", "Burberry"), false);
  const verified = result.products.find((p) => p.retailReference?.status === "verified")!;
  assert.equal(isVerifiedRetail({ ...verified, name: "Other concentration" }), false);
  assert.equal(isVerifiedRetail(verified, Date.parse("2027-01-01")), false);
  assert.notEqual(retailReferenceError({ ...verified.retailReference, priceCents: 12.5 }, verified.brand), null);
  const html = renderToStaticMarkup(createElement(RetailReferenceLine, { product: verified }));
  assert.match(html, /Full-size retail:/);
  assert.match(html, /Source:/);
  assert.match(renderToStaticMarkup(createElement(RetailReferenceLine, { product: { ...verified, name: "Changed identity" } })), /Not verified/);
  await fake.set("amoruh:products", catalog);
  // Force an inventory change BETWEEN planning and EVAL. CAS must retry with
  // the new inventory and preserve it, not restore the stale value of 5.
  const originalEval = fake.eval.bind(fake);
  let raced = false;
  fake.eval = async (...args: Parameters<typeof fake.eval>) => {
    if (!raced) {
      raced = true;
      await fake.set("amoruh:products", catalog.map((p, i) => i === 0 ? { ...p, inventory: 77 } : p));
    }
    return originalEval(...args);
  };
  const applied = await updateCatalogMetadata(planIntakeEnrichment);
  assert.equal(applied.newLiveNotes, 28);
  const saved = await fake.get("amoruh:products") as Product[];
  assert.equal(saved[0].inventory, 77);
  assert.equal(saved[0].cost, 123.45);
  assert.equal(saved[0].retailPrice, 999);
  assert.deepEqual(saved[0].topNotes, []); // Lua must never turn [] into {}
  const version = await fake.get("amoruh:version");
  await updateCatalogMetadata(planIntakeEnrichment);
  assert.equal(await fake.get("amoruh:version"), version); // replay performs no write
  process.env.SITE_PASSCODE = "test"; process.env.AUTH_COOKIE_SECRET = "test-secret";
  const { GET, POST } = await import("../src/app/api/internal/intake-live-enrichment/route");
  const { computeAuthToken } = await import("../src/lib/auth");
  const address = "http://localhost/api/internal/intake-live-enrichment";
  assert.equal((await GET(new NextRequest(address))).status, 401);
  assert.equal((await POST(new NextRequest(address, { method: "POST" }))).status, 401);
  const cookie = `amoruh_auth=${await computeAuthToken()}`;
  assert.equal((await POST(new NextRequest(address, { method: "POST", headers: { cookie, origin: "https://evil.test" } }))).status, 403);
  const response = await POST(new NextRequest(address, { method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ apply: true }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).newLiveNotes, 0);
  const { PUT } = await import("../src/app/api/products/[id]/retail-reference/route");
  const current = (await fake.get("amoruh:products") as Product[])[0];
  const ctx = { params: Promise.resolve({ id: current.id }) };
  const retailAddress = `http://localhost/api/products/${current.id}/retail-reference`;
  assert.equal((await PUT(new NextRequest(retailAddress, { method: "PUT" }), ctx)).status, 401);
  const edited = { ...current.retailReference!, priceCents: current.retailReference!.priceCents! + 100 };
  const editRequest = () => new NextRequest(retailAddress, { method: "PUT", headers: { cookie, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ retailReference: edited, expectedReference: current.retailReference }) });
  assert.equal((await PUT(editRequest(), ctx)).status, 200);
  assert.equal((await PUT(editRequest(), ctx)).status, 409); // stale editor cannot overwrite correction
  const manualSaved = (await fake.get("amoruh:products") as Product[])[0];
  assert.equal(manualSaved.retailReference?.manuallyEdited, true);
  assert.equal(manualSaved.inventory, 77);
  assert.deepEqual(manualSaved.liveNotes, current.liveNotes);
  assert.equal(planIntakeEnrichment([manualSaved]).result.preservedRetailReference, 1);
  console.log("Enrichment: 56 identities, 28 note fills, 13 verified/43 unverified references; preservation, retries, inventory race, no-op replay, source restrictions, display and auth passed.");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
