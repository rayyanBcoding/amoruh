import * as XLSX from "xlsx";
import { upload } from "@vercel/blob/client";

const PREVIEW = process.argv[2];
const BYPASS = "vSSph4hTgA9AYTHrNF5d2KfsNYD2Q7JI";

let authCookie = "";
let passes = 0, failures = 0;
function ok(cond, label, extra) {
  if (cond) { passes++; console.log(`PASS: ${label}`); }
  else { failures++; console.log(`FAIL: ${label}` + (extra !== undefined ? `  -- ${JSON.stringify(extra)}` : "")); }
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
    method: "POST", headers: { "Content-Type": "application/json", "x-vercel-protection-bypass": BYPASS },
    body: JSON.stringify({ code: "7860" }),
  });
  authCookie = (res.headers.get("set-cookie") || "").match(/amoruh_auth=[^;]+/)[0];
  console.log("Logged in.");
}

function buildXlsx(rows) {
  const headers = ["SKU", "Description", "Brand", "Qty", "Price"];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

async function uploadFile(name, buffer) {
  const filename = `${name}-${Date.now()}.xlsx`;
  const blob = await upload(filename, buffer, {
    access: "public", handleUploadUrl: PREVIEW + "/api/pricing/upload",
    headers: { Cookie: authCookie, "x-vercel-protection-bypass": BYPASS },
  });
  return blob.url;
}

function genRows(prefix, count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push([`${prefix}-SKU-${i}`, `${prefix} Test Product ${i} Fragrance`, "TestBrand", 10, 50 + i]);
  }
  return rows;
}

const COLUMN_MAP = { supplierSku: 0, description: 1, brand: 2, quantity: 3, price: 4 };

async function processUpload(supplierId, blobUrl, uploadType, filename) {
  const preview = await api("POST", "/api/pricing/parse-preview", { supplierId, blobUrl });
  const result = await api("POST", "/api/pricing/process", {
    supplierId, blobUrl, filename, uploadType,
    headerRowIndex: preview.data.headerRowIndex, headerSignature: preview.data.headerSignature, columnMap: preview.data.columnMap,
  });
  return result.data;
}

async function getSupplierBreakdown(supplierId) {
  const dash = await api("GET", "/api/pricing/dashboard");
  return dash.data.matchReview.bySupplier.find((s) => s.supplierId === supplierId);
}

async function main() {
  await login();
  const rand = Math.random().toString(36).slice(2, 8);
  const sup = await api("POST", "/api/pricing/suppliers", { name: `TEST_PRICING_Supersession_${rand}` });
  const supplierId = sup.data.id;
  console.log("Test supplier:", supplierId);

  // Upload A: full, 50 products
  const bufA = buildXlsx(genRows("A", 50));
  const urlA = await uploadFile("Supersession-A", bufA);
  const resA = await processUpload(supplierId, urlA, "full", "Upload-A.xlsx");
  ok(resA.status === "completed", "Upload A (full, 50 products) completed", resA);

  let breakdown = await getSupplierBreakdown(supplierId);
  ok(breakdown.currentlyListed === 50, "After A: 50 currently listed", breakdown);
  ok(breakdown.noLongerListed === 0, "After A: 0 no longer listed", breakdown);

  // Upload B: full, 60 COMPLETELY DIFFERENT products
  const bufB = buildXlsx(genRows("B", 60));
  const urlB = await uploadFile("Supersession-B", bufB);
  const resB = await processUpload(supplierId, urlB, "full", "Upload-B.xlsx");
  ok(resB.status === "completed", "Upload B (full, 60 different products) completed", resB);

  breakdown = await getSupplierBreakdown(supplierId);
  ok(breakdown.currentlyListed === 60, "After B: exactly 60 currently listed (not 110)", breakdown);
  ok(breakdown.noLongerListed === 50, "After B: exactly 50 no longer listed (A's products retained)", breakdown);
  const totalOperational = breakdown.matched + breakdown.reviewRequired + breakdown.newCandidates;
  ok(totalOperational === 60, "After B: Match Review operational total = 60, not 110", { totalOperational, breakdown });

  // Confirm new_candidates bucket for this supplier shows exactly 60, all B's products, none of A's
  const candidates = await api("GET", `/api/pricing/match-review?bucket=new_candidates&supplierId=${supplierId}&limit=100`);
  ok(candidates.data.total === 60, "new_candidates bucket shows exactly 60 for this supplier", candidates.data.total);
  const hasAProduct = candidates.data.items.some((i) => i.description.startsWith("A Test Product"));
  const hasBProduct = candidates.data.items.some((i) => i.description.startsWith("B Test Product"));
  ok(!hasAProduct, "None of A's delisted products appear in new_candidates", candidates.data.items.map(i=>i.description).filter(d=>d.startsWith("A ")));
  ok(hasBProduct, "B's products correctly appear in new_candidates");

  // Upload C: partial, touching 5 of B's 60 rows with new prices
  const touchedRows = genRows("B", 60).slice(0, 5).map((r) => [r[0], r[1], r[2], 999, 12345]);
  const bufC = buildXlsx(touchedRows);
  const urlC = await uploadFile("Supersession-C", bufC);
  const resC = await processUpload(supplierId, urlC, "partial", "Upload-C.xlsx");
  ok(resC.status === "completed", "Upload C (partial, 5 of B's rows) completed", resC);

  breakdown = await getSupplierBreakdown(supplierId);
  ok(breakdown.currentlyListed === 60, "After C (partial): still exactly 60 currently listed", breakdown);
  ok(breakdown.noLongerListed === 50, "After C (partial): still exactly 50 no longer listed (unchanged)", breakdown);

  const afterC = await api("GET", `/api/pricing/match-review?bucket=new_candidates&supplierId=${supplierId}&limit=100`);
  ok(afterC.data.total === 60, "After C: new_candidates total still exactly 60 (no duplicates created)", afterC.data.total);
  const touchedItem = afterC.data.items.find((i) => i.description === "B Test Product 0 Fragrance");
  ok(!!touchedItem && touchedItem.price === 12345 && touchedItem.quantity === 999, "Touched offer (B-SKU-0) reflects C's updated price/qty", touchedItem);
  const untouchedItem = afterC.data.items.find((i) => i.description === "B Test Product 10 Fragrance");
  ok(!!untouchedItem && untouchedItem.price === 60, "Untouched offer (B-SKU-10) unchanged by partial upload", untouchedItem);

  console.log(`\n${passes} passed, ${failures} failed.\n`);
  console.log("CLEANUP_SUPPLIER_ID=" + supplierId);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => { console.error("ERROR:", err); process.exit(1); });
