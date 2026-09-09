import fs from "fs";
import { upload } from "@vercel/blob/client";

const PREVIEW = process.argv[2];
const BYPASS = "vSSph4hTgA9AYTHrNF5d2KfsNYD2Q7JI";
const JIZAN_SUPPLIER_ID = "sup_1788861090903_xj9mqr";
if (!PREVIEW) { console.error("usage: node jizan-ingestion-test.mjs <preview-url>"); process.exit(1); }

let authCookie = "";
let failures = 0;
let passes = 0;

function ok(cond, label, extra) {
  if (cond) { passes++; console.log(`PASS: ${label}`); }
  else { failures++; console.log(`FAIL: ${label}` + (extra !== undefined ? `  -- ${JSON.stringify(extra).slice(0,500)}` : "")); }
}

async function api(method, path, body) {
  const res = await fetch(PREVIEW + path, {
    method,
    headers: { "Content-Type": "application/json", "x-vercel-protection-bypass": BYPASS, ...(authCookie ? { Cookie: authCookie } : {}) },
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
  if (!match) throw new Error("Login failed: " + JSON.stringify([res.status, setCookie]));
  authCookie = match[0];
  console.log("Logged in.");
}

async function uploadFile(filenameBase, buffer) {
  const filename = `${filenameBase}-${Date.now()}.xlsx`;
  const blob = await upload(filename, buffer, {
    access: "public",
    handleUploadUrl: PREVIEW + "/api/pricing/upload",
    headers: { Cookie: authCookie, "x-vercel-protection-bypass": BYPASS },
  });
  return blob.url;
}

async function main() {
  await login();
  const buf = fs.readFileSync("/tmp/jizan_real.xlsx");
  console.log("Uploading real Jizan file...");
  const blobUrl = await uploadFile("Jizan-real-retest", buf);
  console.log("blobUrl:", blobUrl);

  // 1. Initial preview - no overrides
  const p1 = await api("POST", "/api/pricing/parse-preview", { supplierId: JIZAN_SUPPLIER_ID, blobUrl });
  ok(p1.status === 200, "parse-preview succeeds", p1.data);
  ok(p1.data.detectedHeaderRowIndex === 2, "Header row auto-detected as index 2 (Row 3)", p1.data.detectedHeaderRowIndex);
  ok(p1.data.headerConfident === true, "Header detection is confident", p1.data.headerConfident);
  ok(p1.data.headerRowIndex === 2, "Resolved header row is index 2", p1.data.headerRowIndex);

  const cols = p1.data.columns;
  const findCol = (h) => cols.find((c) => c.header.toUpperCase() === h);
  ok(findCol("ITEM CODE")?.letter === "B", "ITEM CODE column correctly shown as letter B", findCol("ITEM CODE"));
  ok(findCol("BARCODE")?.letter === "C", "BARCODE column correctly shown as letter C", findCol("BARCODE"));
  ok(findCol("BRAND")?.letter === "D", "BRAND column correctly shown as letter D", findCol("BRAND"));
  ok(findCol("ITEM DESCRIPTION")?.letter === "E", "ITEM DESCRIPTION column correctly shown as letter E", findCol("ITEM DESCRIPTION"));
  ok(findCol("QTY")?.letter === "H", "QTY column correctly shown as letter H", findCol("QTY"));
  ok(cols.every((c) => /^[A-Z]+$/.test(c.letter)), "Every column has a real Excel letter, never a bare number");
  ok(findCol("ITEM CODE")?.samples?.length > 0, "Columns include real sample values", findCol("ITEM CODE"));

  console.log("Suggested columnMap:", JSON.stringify(p1.data.columnMap));
  ok(p1.data.totalProductRows > 6000 && p1.data.totalProductRows <= 6305, "Total product rows realistic (~6,305), not thousands of junk rows", p1.data.totalProductRows);
  ok(p1.data.sanityCheck.ok === true, "Sanity check passes with the correct header row", p1.data.sanityCheck);

  const firstPreviewRow = p1.data.previewRows[0];
  ok(firstPreviewRow && firstPreviewRow.description.includes("ALEXANDRE J"), "Preview row's Description is a real product description, not a barcode", firstPreviewRow);
  ok(firstPreviewRow && firstPreviewRow.price > 0 && firstPreviewRow.price < 1000, "Preview row's Price is a real numeric price", firstPreviewRow);

  // Build the fully-correct mapping explicitly (using PRICE USD + currency defaulted, or PRICE AED+AED currency - use USD column directly, price as-is)
  const correctMap = {
    supplierSku: findCol("ITEM CODE").index,
    upc: findCol("BARCODE").index,
    brand: findCol("BRAND").index,
    description: findCol("ITEM DESCRIPTION").index,
    quantity: findCol("QTY").index,
    price: findCol("PRICE AED")?.index ?? cols.find(c=>c.header.trim().toUpperCase()==="PRICE AED")?.index,
    category: findCol("TYPE")?.index,
  };
  console.log("Correct map used for processing:", JSON.stringify(correctMap));

  // 2. Re-preview with the confirmed correct map
  const p2 = await api("POST", "/api/pricing/parse-preview", { supplierId: JIZAN_SUPPLIER_ID, blobUrl, headerRowIndex: 2, columnMap: correctMap });
  ok(p2.status === 200 && p2.data.sanityCheck.ok === true, "Preview with fully-correct mapping passes sanity", p2.data.sanityCheck);
  ok(p2.data.totalProductRows >= 6300, "Correct mapping parses ~6,305 real rows", p2.data.totalProductRows);

  const headerSignature = p2.data.headerSignature;

  // 3. Test the verify-guard: wrong headerSignature should be rejected
  const badSig = await api("POST", "/api/pricing/process", {
    supplierId: JIZAN_SUPPLIER_ID, blobUrl, filename: "Jizan-test", uploadType: "full",
    headerRowIndex: 2, headerSignature: ["totally", "wrong", "signature"], columnMap: correctMap,
  });
  ok(badSig.status !== 200, "Process rejects a stale/mismatched headerSignature", badSig.data);
  ok(String(badSig.data?.error||"").toLowerCase().includes("preview"), "Rejection message points back to Preview", badSig.data);

  // 4. Test server-side sanity re-check: swap price->description column (garbage mapping) should be blocked, nothing written
  const beforeDash = await api("GET", "/api/pricing/dashboard");
  const garbageMap = { ...correctMap, price: findCol("ITEM DESCRIPTION").index, description: findCol("BARCODE").index };
  const badMapRes = await api("POST", "/api/pricing/process", {
    supplierId: JIZAN_SUPPLIER_ID, blobUrl, filename: "Jizan-test-garbage", uploadType: "full",
    headerRowIndex: 2, headerSignature, columnMap: garbageMap,
  });
  ok(badMapRes.status !== 200, "Process rejects a garbage columnMap via server-side sanity re-check", badMapRes.data);
  ok(String(badMapRes.data?.error||"").toLowerCase().includes("validation"), "Rejection message cites validation failure", badMapRes.data);
  const afterDash = await api("GET", "/api/pricing/dashboard");
  ok(afterDash.data.matchReview.total === beforeDash.data.matchReview.total, "Garbage-mapping attempt wrote NOTHING to Match Review", { before: beforeDash.data.matchReview.total, after: afterDash.data.matchReview.total });

  // 5. Real process with the correct, confirmed mapping
  const realRes = await api("POST", "/api/pricing/process", {
    supplierId: JIZAN_SUPPLIER_ID, blobUrl, filename: "Jizan Export Price list 07.09.2026 N.xlsx", uploadType: "full",
    headerRowIndex: 2, headerSignature, columnMap: correctMap,
  });
  ok(realRes.status === 200 && realRes.data.status === "completed", "Real Jizan upload with correct mapping completes", realRes.data);
  console.log("Real upload result:", JSON.stringify(realRes.data));
  ok(realRes.data.newCandidates + realRes.data.autoMatched + realRes.data.needsReview >= 6300, "Realistic total product count processed", realRes.data);

  // 6. Match Review sanity spot check
  const mr = await api("GET", "/api/pricing/match-review");
  const jizanItems = mr.data.items.filter((i) => i.supplierId === JIZAN_SUPPLIER_ID);
  const sample = jizanItems[0];
  ok(!!sample && sample.description.length > 5 && !/^\d+$/.test(sample.description), "Match Review item has a real text description, not a barcode", sample);
  ok(!!sample && sample.price > 0, "Match Review item has a real positive price", sample);

  // 7. Remembered mapping - re-preview should reuse
  const p3 = await api("POST", "/api/pricing/parse-preview", { supplierId: JIZAN_SUPPLIER_ID, blobUrl });
  ok(p3.data.mappingReused === true, "Re-preview reuses the confirmed mapping", p3.data.mappingReused);
  ok(p3.data.headerRowIndex === 2, "Reused mapping still resolves to header row index 2", p3.data.headerRowIndex);

  console.log(`\n${passes} passed, ${failures} failed.\n`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => { console.error("SCRIPT ERROR:", err); process.exit(1); });
