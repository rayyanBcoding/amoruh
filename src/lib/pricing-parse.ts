import * as XLSX from "xlsx";
import type { SupplierColumnMapping } from "./intake-types";
import type { SupplierRawRow } from "./pricing-types";

// ---------------------------------------------------------------------
// Deterministic spreadsheet parsing for supplier price lists — no
// Claude call. Unlike invoice PDFs (intake-parse.ts), a price sheet is
// already structured tabular data; a keyword-heuristic column mapping,
// confirmed once by the operator and remembered per supplier, is
// faster, cheaper, and more predictable than an LLM re-guessing the
// layout on every upload.
// ---------------------------------------------------------------------

export interface ParsedSheet {
  headers: string[];
  rows: string[][];
}

export function parseSpreadsheet(buffer: ArrayBuffer): ParsedSheet {
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false });

  const rows = data.filter((r) => Array.isArray(r) && r.some((cell) => String(cell).trim() !== ""));
  if (rows.length === 0) return { headers: [], rows: [] };

  const [headerRow, ...dataRows] = rows;
  return {
    headers: headerRow.map((h) => String(h ?? "").trim()),
    rows: dataRows.map((r) => r.map((c) => String(c ?? "").trim())),
  };
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

export function computeHeaderSignature(headers: string[]): string[] {
  return headers.map(normalizeHeader);
}

/** Exact-after-normalization comparison, deliberately conservative: a
 *  trivial rename/whitespace difference is absorbed by normalizeHeader,
 *  but anything else (added/removed/reordered column) is treated as a
 *  material change and re-prompts the mapping screen, per the spec's
 *  "if the structure changes materially, ask us to review it again." */
export function signatureMatches(stored: string[], incoming: string[]): boolean {
  if (stored.length !== incoming.length) return false;
  return stored.every((h, i) => h === incoming[i]);
}

const KEYWORD_RULES: [keyof SupplierColumnMapping["columnMap"], RegExp][] = [
  ["supplierSku", /\bsku\b|\bitem\s*(no|number|code)\b|\bproduct\s*code\b|\bref\b/],
  ["upc", /\bupc\b/],
  ["ean", /\bean\b|\bbarcode\b/],
  ["brand", /\bbrand\b|\bdesigner\b|\bmanufacturer\b/],
  ["quantity", /\bqty\b|\bquantity\b|\bstock\b|\bavailable\b|\bavail\b|\bon\s*hand\b/],
  ["currency", /\bcurrency\b|\bccy\b/],
  ["price", /\bprice\b|\bcost\b|\brate\b|\bunit\s*price\b/],
  ["category", /\bcategory\b|\btype\b|\bgroup\b/],
  ["description", /\bdescription\b|\bname\b|\bproduct\b|\bitem\b|\btitle\b/],
];

/** Best-guess mapping from header text — never auto-applied on its own;
 *  always shown to the operator for confirmation on first use for a
 *  supplier (subsequent uploads reuse the confirmed mapping via
 *  signatureMatches, see above). */
export function suggestColumnMapping(headers: string[]): SupplierColumnMapping["columnMap"] {
  const map: SupplierColumnMapping["columnMap"] = {};
  const used = new Set<number>();

  for (const [field, pattern] of KEYWORD_RULES) {
    const idx = headers.findIndex((h, i) => !used.has(i) && pattern.test(normalizeHeader(h)));
    if (idx !== -1) {
      map[field] = idx;
      used.add(idx);
    }
  }
  return map;
}

/** Applies a confirmed mapping to raw data rows -> normalized
 *  SupplierRawRow[]. Missing/unmapped fields default sensibly (empty
 *  string, null quantity, "USD" currency) rather than throwing — a
 *  malformed single row shouldn't abort an entire multi-thousand-row
 *  upload; unparseable price rows are simply not actionable later. */
export function applyColumnMapping(rows: string[][], columnMap: SupplierColumnMapping["columnMap"]): SupplierRawRow[] {
  const cell = (row: string[], idx: number | undefined): string => (idx === undefined ? "" : (row[idx] ?? "").trim());

  return rows.map((row) => {
    const priceRaw = cell(row, columnMap.price).replace(/[^0-9.\-]/g, "");
    const qtyRaw = cell(row, columnMap.quantity).replace(/[^0-9.\-]/g, "");
    return {
      supplierSku: cell(row, columnMap.supplierSku),
      description: cell(row, columnMap.description),
      brand: cell(row, columnMap.brand),
      quantity: qtyRaw ? Math.round(parseFloat(qtyRaw)) : null,
      price: priceRaw ? parseFloat(priceRaw) : 0,
      currency: cell(row, columnMap.currency).toUpperCase() || "USD",
      upc: cell(row, columnMap.upc),
      ean: cell(row, columnMap.ean),
      category: cell(row, columnMap.category),
    };
  });
}
