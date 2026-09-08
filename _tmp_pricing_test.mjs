import * as XLSX from "xlsx";
import { upload } from "@vercel/blob/client";

const PREVIEW = process.argv[2];
const BYPASS = "vSSph4hTgA9AYTHrNF5d2KfsNYD2Q7JI";
if (!PREVIEW) { console.error("usage: node pricing-test.mjs <preview-url>"); process.exit(1); }

let authCookie = "";
let failures = 0;
let passes = 0;

function ok(cond, label, extra) {
  if (cond) { passes++; console.log(`PASS: ${label}`); }
  else { failures++; console.log(`FAIL: ${label}` + (extra !== undefined ? `  -- ${JSON.stringify(extra)}` : "")); }
}

async function api(method, path, body) {
  const res = await fetch(PREVIEW + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-vercel-protection-bypass": BYPASS,
      ...(authCookie ? { Cookie: authCookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function login() {
  const res = await fetch(PREVIEW + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-vercel-protection-bypass": BYPASS },
    body: JSON.stringify({ code: "7860" }),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/amoruh_auth=[^;]+/);
  if (!match) throw new Error("Login failed to set cookie: " + JSON.stringify([res.status, setCookie]));
  authCookie = match[0];
  console.log("Logged in, status", res.status);
}

function buildXlsx(headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

async function uploadFile(filenameBase, buffer) {
  const filename = `${filenameBase}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.xlsx`;
  const blob = await upload(filename, buffer, {
    access: "public",
    handleUploadUrl: PREVIEW + "/api/pricing/upload",
    headers: { Cookie: authCookie, "x-vercel-protection-bypass": BYPASS },
  });
  return blob.url;
}

async function processFile({ supplierId, buffer, filenameBase, uploadType, columnMap, retryUploadId }) {
  const blobUrl = await uploadFile(filenameBase, buffer);
  const { status, data } = await api("POST", "/api/pricing/process", {
    supplierId, blobUrl, filename: filenameBase, uploadType, columnMap, retryUploadId,
  });
  return { status, data, blobUrl };
}

async function dump(supplierId) {
  const { data } = await api("GET", `/api/pricing/devtest/dump-generation?supplierId=${supplierId}`);
  return data;
}

function findOffer(comparisonData, supplierId, offerKey) {
  return [...comparisonData.actionable, ...comparisonData.nonActionable].find(
    (o) => o.supplierId === supplierId && o.offerKey === offerKey
  );
}

const HEADERS = ["SKU", "Description", "Brand", "Qty", "Price", "Currency", "UPC"];
const COLUMN_MAP = { supplierSku: 0, description: 1, brand: 2, quantity: 3, price: 4, currency: 5, upc: 6 };

async function main() {
  await login();

  const rand = Math.random().toString(36).slice(2, 8);
  const testProducts = {};
  const productSpecs = [
    { key: "aventus", sku: `TEST_PRICING_AVENTUS_${rand}`, barcode: `TESTUPC${rand}01`, brand: "Creed", name: "Aventus", size: "100ml", concentration: "Eau de Parfum" },
    { key: "aventusCologne", sku: `TEST_PRICING_AVENTUSCOL_${rand}`, barcode: `TESTUPC${rand}02`, brand: "Creed", name: "Aventus Cologne", size: "100ml", concentration: "Cologne" },
    { key: "sauvageEdt", sku: `TEST_PRICING_SAUVAGE_EDT_${rand}`, barcode: `TESTUPC${rand}03`, brand: "Dior", name: "Sauvage", size: "100ml", concentration: "Eau de Toilette" },
    { key: "sauvageEdp", sku: `TEST_PRICING_SAUVAGE_EDP_${rand}`, barcode: `TESTUPC${rand}04`, brand: "Dior", name: "Sauvage", size: "100ml", concentration: "Eau de Parfum" },
    { key: "jpgElixir", sku: `TEST_PRICING_JPG_ELIXIR_${rand}`, barcode: `TESTUPC${rand}05`, brand: "Jean Paul Gaultier", name: "Le Male Elixir", size: "125ml", concentration: "Elixir" },
    { key: "jpgLeParfum", sku: `TEST_PRICING_JPG_LEPARFUM_${rand}`, barcode: `TESTUPC${rand}06`, brand: "Jean Paul Gaultier", name: "Le Male Le Parfum", size: "125ml", concentration: "Parfum" },
    { key: "yslY", sku: `TEST_PRICING_YSL_Y_${rand}`, barcode: `TESTUPC${rand}07`, brand: "YSL", name: "Y", size: "100ml", concentration: "Eau de Parfum" },
  ];
  for (const spec of productSpecs) {
    const { status, data } = await api("POST", "/api/products", {
      sku: spec.sku, barcode: spec.barcode, brand: spec.brand, name: spec.name,
      size: spec.size, concentration: spec.concentration, cost: 50, retailPrice: 0,
      marketPrice: 0, lootPrice: 0, minPrice: 0, inventory: 0, status: "draft",
    });
    ok(status === 200 || status === 201, `setup: create product ${spec.key}`, data);
    testProducts[spec.key] = data;
  }

  const supA = await api("POST", "/api/pricing/suppliers", { name: `TEST_PRICING_SupplierA_${rand}` });
  const supB = await api("POST", "/api/pricing/suppliers", { name: `TEST_PRICING_SupplierB_${rand}` });
  ok(supA.status === 200, "setup: create SupplierA", supA.data);
  ok(supB.status === 200, "setup: create SupplierB", supB.data);
  const supplierAId = supA.data.id;
  const supplierBId = supB.data.id;
  console.log("Supplier A:", supplierAId, "Supplier B:", supplierBId);

  // ---------------------------------------------------------------
  // Test 1: Full upload — exact UPC, word-order fuzzy, brand-initialism
  // (JPG), hard rejections (cologne flanker, EDT/EDP, elixir/le parfum,
  // tester/giftset, 50ml/100ml), AED currency.
  // ---------------------------------------------------------------
  const rows1 = [
    [`SKU-UPC`, `Creed Aventus 100ml EDP`, "", 24, 178, "USD", testProducts.aventus.barcode],
    [`SKU-WORDORDER`, `Aventus by Creed 100ml`, "", 30, 175, "USD", ""],
    [`SKU-COLOGNE`, `Creed Aventus Cologne 100ml`, "", 12, 150, "USD", ""],
    [`SKU-SAUVAGE-EDT`, `Dior Sauvage EDT 100ml`, "", 40, 90, "USD", testProducts.sauvageEdt.barcode],
    [`SKU-SAUVAGE-EDP`, `Dior Sauvage EDP 100ml`, "", 20, 110, "USD", testProducts.sauvageEdp.barcode],
    [`SKU-JPG-ELIXIR`, `JPG Le Male Elixir 125ml`, "", 15, 95, "USD", testProducts.jpgElixir.barcode],
    [`SKU-JPG-LEPARFUM`, `JPG Le Male Le Parfum 125ml`, "", 15, 98, "USD", testProducts.jpgLeParfum.barcode],
    [`SKU-TESTER`, `Creed Aventus 100ml Tester`, "", 5, 140, "USD", ""],
    [`SKU-GIFTSET`, `Creed Aventus 100ml Gift Set`, "", 3, 220, "USD", ""],
    [`SKU-50ML`, `Creed Aventus 50ml`, "", 10, 95, "USD", ""],
    [`SKU-YSL-AED`, `YSL Y EDP 100ml`, "", 18, 653.79, "AED", testProducts.yslY.barcode],
  ];
  const buf1 = buildXlsx(HEADERS, rows1);
  const up1 = await processFile({ supplierId: supplierAId, buffer: buf1, filenameBase: "SupplierA-Full1", uploadType: "full", columnMap: COLUMN_MAP });
  ok(up1.status === 200 && up1.data.status === "completed", "Upload A1 (full) completed", up1.data);
  console.log("Upload A1 result:", JSON.stringify(up1.data));

  const mr1 = await api("GET", "/api/pricing/match-review");
  const a1Items = mr1.data.items.filter((i) => i.supplierId === supplierAId);
  const byDesc = (d) => a1Items.find((i) => i.description === d);

  ok(!!byDesc("Creed Aventus 100ml Tester"), "Tester listing routed to review/candidate, not auto-matched to Aventus", a1Items.map(i=>i.description));
  ok(!!byDesc("Creed Aventus 100ml Gift Set"), "Gift-set listing routed to review/candidate, not auto-matched to Aventus", a1Items.map(i=>i.description));
  ok(!!byDesc("Creed Aventus 50ml"), "50ml listing routed to review/candidate (not merged with 100ml)", a1Items.map(i=>i.description));

  const aventusOffers = await api("GET", `/api/pricing/products/${testProducts.aventus.id}/offers`);
  ok(!!findOffer(aventusOffers.data, supplierAId, "sku:sku-wordorder"), "Word-order row ('Aventus by Creed 100ml') auto-matched to Aventus product", aventusOffers.data);
  ok(!findOffer(aventusOffers.data, supplierAId, "sku:sku-cologne"), "Cologne-flanker row NOT attached to plain Aventus product", aventusOffers.data);

  const aventusColOffers = await api("GET", `/api/pricing/products/${testProducts.aventusCologne.id}/offers`);
  ok(!!findOffer(aventusColOffers.data, supplierAId, "sku:sku-cologne"), "Cologne-flanker row correctly attached to the distinct Aventus Cologne product", aventusColOffers.data);

  const sauvageEdtOffers = await api("GET", `/api/pricing/products/${testProducts.sauvageEdt.id}/offers`);
  const sauvageEdpOffers = await api("GET", `/api/pricing/products/${testProducts.sauvageEdp.id}/offers`);
  ok([...sauvageEdtOffers.data.actionable, ...sauvageEdtOffers.data.nonActionable].length === 1, "Sauvage EDT offer attached only to EDT product", sauvageEdtOffers.data);
  ok([...sauvageEdpOffers.data.actionable, ...sauvageEdpOffers.data.nonActionable].length === 1, "Sauvage EDP offer attached only to EDP product", sauvageEdpOffers.data);

  const jpgElixirOffers = await api("GET", `/api/pricing/products/${testProducts.jpgElixir.id}/offers`);
  const jpgLeParfumOffers = await api("GET", `/api/pricing/products/${testProducts.jpgLeParfum.id}/offers`);
  ok(!!findOffer(jpgElixirOffers.data, supplierAId, "sku:sku-jpg-elixir"), "JPG (brand initialism) Elixir offer correctly auto-matched to Elixir product", jpgElixirOffers.data);
  ok(!!findOffer(jpgLeParfumOffers.data, supplierAId, "sku:sku-jpg-leparfum"), "JPG (brand initialism) Le Parfum offer correctly auto-matched to Le Parfum product", jpgLeParfumOffers.data);
  ok([...jpgElixirOffers.data.actionable, ...jpgElixirOffers.data.nonActionable].length === 1, "JPG Elixir offer attached only to Elixir product (not Le Parfum too)", jpgElixirOffers.data);
  ok([...jpgLeParfumOffers.data.actionable, ...jpgLeParfumOffers.data.nonActionable].length === 1, "JPG Le Parfum offer attached only to Le Parfum product (not Elixir too)", jpgLeParfumOffers.data);

  const yslOffers = await api("GET", `/api/pricing/products/${testProducts.yslY.id}/offers`);
  const yslRow = findOffer(yslOffers.data, supplierAId, "sku:sku-ysl-aed");
  ok(!!yslRow && yslRow.currency === "AED" && yslRow.price === 653.79, "AED row preserves original currency/price", yslRow);
  ok(!!yslRow && yslRow.priceUsd > 0 && yslRow.priceUsd !== yslRow.price, "AED row has separate USD comparison figure", yslRow);

  // ---------------------------------------------------------------
  // Test 2: Full upload A2 — Aventus word-order row removed -> "No
  // Longer Listed"; everything else (still present) stays listed.
  // ---------------------------------------------------------------
  const rows2 = rows1.filter((r) => r[0] !== "SKU-WORDORDER");
  const buf2 = buildXlsx(HEADERS, rows2);
  const up2 = await processFile({ supplierId: supplierAId, buffer: buf2, filenameBase: "SupplierA-Full2", uploadType: "full", columnMap: COLUMN_MAP });
  ok(up2.status === 200 && up2.data.status === "completed", "Upload A2 (full, missing one row) completed", up2.data);

  const aventusOffers2 = await api("GET", `/api/pricing/products/${testProducts.aventus.id}/offers`);
  const wordOrderAfter = findOffer(aventusOffers2.data, supplierAId, "sku:sku-wordorder");
  ok(!!wordOrderAfter && wordOrderAfter.currentlyListed === false, "Row missing from a full upload correctly marked No Longer Listed", wordOrderAfter);
  const upcStillListed = findOffer(aventusOffers2.data, supplierAId, "sku:sku-upc");
  ok(!!upcStillListed && upcStillListed.currentlyListed === true, "Row still present in the full upload stays Currently Listed", upcStillListed);

  const sauvageEdtOffers2 = await api("GET", `/api/pricing/products/${testProducts.sauvageEdt.id}/offers`);
  const stillListed = findOffer(sauvageEdtOffers2.data, supplierAId, "sku:sku-sauvage-edt");
  ok(!!stillListed && stillListed.currentlyListed === true, "Unrelated row also still present after full upload stays Currently Listed", stillListed);

  // ---------------------------------------------------------------
  // Test 3: Partial upload — only touches ONE row; everything else must
  // stay exactly as-is (never marked unavailable).
  // ---------------------------------------------------------------
  const rows3 = [[`SKU-SAUVAGE-EDT`, `Dior Sauvage EDT 100ml`, "", 999, 91, "USD", testProducts.sauvageEdt.barcode]];
  const buf3 = buildXlsx(HEADERS, rows3);
  const up3 = await processFile({ supplierId: supplierAId, buffer: buf3, filenameBase: "SupplierA-Partial1", uploadType: "partial", columnMap: COLUMN_MAP });
  ok(up3.status === 200 && up3.data.status === "completed", "Upload A3 (partial) completed", up3.data);

  const jpgElixirOffers3 = await api("GET", `/api/pricing/products/${testProducts.jpgElixir.id}/offers`);
  const stillThere = findOffer(jpgElixirOffers3.data, supplierAId, "sku:sku-jpg-elixir");
  ok(!!stillThere && stillThere.currentlyListed === true, "Partial upload leaves an untouched offer exactly as it was (not wiped)", stillThere);

  const sauvageEdtOffers3 = await api("GET", `/api/pricing/products/${testProducts.sauvageEdt.id}/offers`);
  const updated = findOffer(sauvageEdtOffers3.data, supplierAId, "sku:sku-sauvage-edt");
  ok(!!updated && updated.quantity === 999, "Partial upload's touched row IS updated (qty=999)", updated);

  // ---------------------------------------------------------------
  // Test 4: Alias re-use — SKU-SAUVAGE-EDT was auto-matched + aliased;
  // re-uploading the identical SKU/description auto-matches via alias
  // with no new review item.
  // ---------------------------------------------------------------
  const mrBeforeAliasReuse = await api("GET", "/api/pricing/match-review");
  const beforeCount = mrBeforeAliasReuse.data.items.filter((i) => i.supplierId === supplierAId).length;
  const buf4 = buildXlsx(HEADERS, rows3);
  const up4 = await processFile({ supplierId: supplierAId, buffer: buf4, filenameBase: "SupplierA-AliasReuse", uploadType: "partial", columnMap: COLUMN_MAP });
  ok(up4.status === 200 && up4.data.autoMatched === 1 && up4.data.needsReview === 0, "Alias re-use auto-matches with no review needed", up4.data);
  const mrAfterAliasReuse = await api("GET", "/api/pricing/match-review");
  const afterCount = mrAfterAliasReuse.data.items.filter((i) => i.supplierId === supplierAId).length;
  ok(afterCount === beforeCount, "Alias re-use does not add a new review item", { beforeCount, afterCount });

  // ---------------------------------------------------------------
  // Test 5: Alias conflict — same SKU/offerKey as SAUVAGE-EDT's alias,
  // materially different size/concentration -> must NOT auto-link.
  // ---------------------------------------------------------------
  const rows5 = [[`SKU-SAUVAGE-EDT`, `Dior Sauvage Elixir 50ml`, "", 5, 200, "USD", ""]];
  const buf5 = buildXlsx(HEADERS, rows5);
  const up5 = await processFile({ supplierId: supplierAId, buffer: buf5, filenameBase: "SupplierA-AliasConflict", uploadType: "partial", columnMap: COLUMN_MAP });
  ok(up5.status === 200, "Alias-conflict upload processed", up5.data);
  const mr5 = await api("GET", "/api/pricing/match-review");
  const conflictItem = mr5.data.items.find((i) => i.supplierId === supplierAId && i.reviewStatus === "alias_conflict");
  ok(!!conflictItem, "Reused SKU with materially different attributes flagged as alias_conflict, not auto-linked", mr5.data.items.filter(i=>i.supplierId===supplierAId));

  // Restore SAUVAGE-EDT's normal state for later tests (undo test 5).
  const buf5fix = buildXlsx(HEADERS, rows3);
  await processFile({ supplierId: supplierAId, buffer: buf5fix, filenameBase: "SupplierA-Restore", uploadType: "partial", columnMap: COLUMN_MAP });

  // ---------------------------------------------------------------
  // Test 6: Best Current Price must mean actually buyable — an
  // out-of-stock offer must never be "best," even if it's cheapest, and
  // must still be visible for context in nonActionable.
  // ---------------------------------------------------------------
  const rows6 = [[`SKU-B-SAUVAGE-EDT-CHEAP`, `Dior Sauvage EDT 100ml`, "", 0, 10, "USD", testProducts.sauvageEdt.barcode]];
  const buf6 = buildXlsx(HEADERS, rows6);
  const up6 = await processFile({ supplierId: supplierBId, buffer: buf6, filenameBase: "SupplierB-Full1", uploadType: "full", columnMap: COLUMN_MAP });
  ok(up6.status === 200 && up6.data.autoMatched === 1, "Supplier B cheap-but-out-of-stock row auto-matched", up6.data);
  const sauvageEdtFinal = await api("GET", `/api/pricing/products/${testProducts.sauvageEdt.id}/offers`);
  const best = sauvageEdtFinal.data.bestPrice;
  ok(!!best && best.price === 91 && best.supplierId === supplierAId, "Fresh, in-stock $91 offer wins Best Current Price over cheaper $10 out-of-stock offer", best);
  const cheapRow = findOffer(sauvageEdtFinal.data, supplierBId, "sku:sku-b-sauvage-edt-cheap");
  ok(!!cheapRow && sauvageEdtFinal.data.nonActionable.includes(cheapRow), "Out-of-stock $10 offer shown for context in nonActionable, excluded from actionable/best", cheapRow);

  // ---------------------------------------------------------------
  // Test 7: A failed upload (bad blobUrl) must leave the previously
  // committed generation byte-for-byte unchanged. Verified precisely via
  // the generation fingerprint (id + seq), not just one field.
  // ---------------------------------------------------------------
  const before = await dump(supplierAId);
  const badRes = await api("POST", "/api/pricing/process", {
    supplierId: supplierAId, blobUrl: "https://example.com/does-not-exist.xlsx",
    filename: "bad.xlsx", uploadType: "partial", columnMap: COLUMN_MAP,
  });
  ok(badRes.status !== 200, "Deliberately-bad blobUrl upload fails (not silently succeeds)", badRes.data);
  const after = await dump(supplierAId);
  ok(
    before.generationId === after.generationId && before.seq === after.seq && JSON.stringify(before.offers) === JSON.stringify(after.offers),
    "Previously committed generation is byte-for-byte unchanged after a failed upload attempt",
    { before: { id: before.generationId, seq: before.seq }, after: { id: after.generationId, seq: after.seq } }
  );

  // ---------------------------------------------------------------
  // Test 8: Out-of-order completion — an upload that STARTED earlier
  // (lower seq) but finishes staging LATER, after a newer upload has
  // already committed, must NOT become current. Simulated deterministically:
  // Upload X starts (gets seq N) but is given a bad blobUrl so it fails
  // before committing; Upload Y starts after (seq N+1) and commits
  // normally; Upload X is then retried (same id, same seq N, now with a
  // valid file) — its commit must be rejected because seq N <= N+1.
  // ---------------------------------------------------------------
  const failFileBuf = buildXlsx(HEADERS, [[`SKU-RACE-X`, `Race Test X`, "", 1, 1, "USD", ""]]);
  const xBlobUrl = await uploadFile("Race-X", failFileBuf);
  const xStartRes = await api("POST", "/api/pricing/process", {
    supplierId: supplierAId, blobUrl: "https://example.com/still-does-not-exist.xlsx",
    filename: "Race-X", uploadType: "partial", columnMap: COLUMN_MAP,
  });
  ok(xStartRes.status !== 200, "Race upload X's first (failing) attempt fails as expected", xStartRes.data);
  // Find X's upload id from the supplier's dump (most recent failed one).
  const dumpAfterXFail = await dump(supplierAId);
  const xUpload = dumpAfterXFail.uploads.find((u) => u.filename === "Race-X" && u.status === "failed");
  ok(!!xUpload, "Race upload X's failed record is findable for retry", dumpAfterXFail.uploads.map(u=>[u.filename,u.status,u.seq]));

  const yRows = [[`SKU-RACE-Y`, `Dior Sauvage EDT 100ml`, "", 7, 77, "USD", testProducts.sauvageEdt.barcode]];
  const yBuf = buildXlsx(HEADERS, yRows);
  const yRes = await processFile({ supplierId: supplierAId, buffer: yBuf, filenameBase: "Race-Y", uploadType: "partial", columnMap: COLUMN_MAP });
  ok(yRes.status === 200 && yRes.data.status === "completed", "Race upload Y (started after X, commits first) completed", yRes.data);
  const genAfterY = await dump(supplierAId);
  ok(genAfterY.seq === xUpload.seq + 1, "Y's seq is exactly one greater than X's (X started first, Y started second)", { xSeq: xUpload.seq, ySeq: genAfterY.seq });

  // Retry X with the SAME id/seq, now pointing at a real file — its
  // commit should be rejected (STALE_GENERATION) since Y already
  // committed a higher seq.
  const xRetryRes = await api("POST", "/api/pricing/process", {
    supplierId: supplierAId, blobUrl: xBlobUrl, filename: "Race-X", uploadType: "partial", columnMap: COLUMN_MAP, retryUploadId: xUpload.id,
  });
  ok(xRetryRes.status === 200 && xRetryRes.data.status === "completed", "Race upload X's retry finishes processing successfully", xRetryRes.data);
  const genAfterXRetry = await dump(supplierAId);
  ok(
    genAfterXRetry.generationId === genAfterY.generationId && genAfterXRetry.seq === genAfterY.seq,
    "X's late-finishing retry (lower seq) does NOT become current — Y's generation remains live",
    { yGen: genAfterY.generationId, afterXRetryGen: genAfterXRetry.generationId }
  );
  ok(!("sku:sku-race-x" in genAfterXRetry.offers), "X's row never appears in the live generation despite X fully processing", Object.keys(genAfterXRetry.offers));

  console.log(`\n${passes} passed, ${failures} failed.\n`);
  console.log("TEST_PRODUCT_IDS=" + JSON.stringify(Object.values(testProducts).map((p) => p.id)));
  console.log("TEST_SUPPLIER_IDS=" + JSON.stringify([supplierAId, supplierBId]));
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("SCRIPT ERROR:", err);
  process.exit(1);
});
