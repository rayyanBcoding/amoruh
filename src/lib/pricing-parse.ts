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
//
// Real supplier files often have preamble rows (company name, a date, a
// "new arrivals" note) before the actual header row — confirmed
// directly against a real supplier's file, which has TWO such rows.
// Nothing here assumes row 0 is the header; header-row detection is a
// first-class step, always overridable by the operator, and NEVER
// re-run once an operator has confirmed a mapping (see
// verifyHeaderSignature, used by the processing path instead).
// ---------------------------------------------------------------------

/** The full grid exactly as the sheet has it — blank rows included, so
 *  row positions match what a human sees opening the file in Excel.
 *  Nothing here decides where headers are. */
export function parseSpreadsheetRaw(buffer: ArrayBuffer): string[][] {
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false });
  return data.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "").trim()) : []));
}

/** 0 -> A, 25 -> Z, 26 -> AA, ... — real Excel column letters, so a
 *  column is never shown as a bare number. */
export function excelColumnLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
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

// ---------------------------------------------------------------------
// Header-row detection
// ---------------------------------------------------------------------

const HEADER_KEYWORD_PATTERNS: RegExp[] = [
  /\bsku\b/, /\bitem\b/, /\bcode\b/, /\bproduct\b/, /\bdescription\b/, /\bbrand\b/,
  /\bqty\b/, /\bquantity\b/, /\bstock\b/, /\bprice\b/, /\bcost\b/, /\bupc\b/,
  /\bean\b/, /\bbarcode\b/, /\bcurrency\b/, /\bcategory\b/, /\bname\b/, /\btitle\b/,
  /\bref\b/, /\bdesigner\b/, /\bmanufacturer\b/, /\brate\b/, /\btype\b/, /\bgroup\b/,
];

const HEADER_DETECT_WINDOW = 20;
/** A single-cell title row like "Jizan Export Price List" scores 1 (the
 *  word "price" matches) — requiring 2 is what correctly disqualifies
 *  it in favor of a real header row with several distinct labeled
 *  columns, confirmed directly against a real supplier file where the
 *  real header scored 8. */
const MIN_HEADER_SCORE = 2;

export interface HeaderDetection {
  index: number;
  confident: boolean;
}

/** Scores each of the first ~20 rows by how many DISTINCT cells match a
 *  known header keyword (not substring hits within one cell — a title
 *  row with one matching word never outscores a real header row with
 *  several labeled columns). */
export function detectHeaderRowIndex(rawRows: string[][]): HeaderDetection {
  let best = { index: 0, score: 0 };
  const window = Math.min(rawRows.length, HEADER_DETECT_WINDOW);
  for (let i = 0; i < window; i++) {
    const row = rawRows[i] ?? [];
    let score = 0;
    for (const cell of row) {
      const n = normalizeHeader(String(cell ?? ""));
      if (n && HEADER_KEYWORD_PATTERNS.some((p) => p.test(n))) score++;
    }
    if (score > best.score) best = { index: i, score };
  }
  return { index: best.index, confident: best.score >= MIN_HEADER_SCORE };
}

/** Resolves which row to treat as the header for a fresh preview pass:
 *  an explicit operator override always wins; otherwise the remembered
 *  row is reused only if it STILL holds the remembered signature on
 *  this file; otherwise auto-detect. This is a SUGGESTION path only —
 *  never used by the processing/verification path, see
 *  verifyHeaderSignature below. */
export function resolveHeaderRow(
  rawRows: string[][],
  overrideIndex: number | undefined,
  remembered: { headerRowIndex: number; headerSignature: string[] } | undefined
): { headerRowIndex: number; confident: boolean; reused: boolean } {
  if (overrideIndex !== undefined) {
    return { headerRowIndex: overrideIndex, confident: true, reused: false };
  }
  if (remembered) {
    const sigAtRow = computeHeaderSignature(rawRows[remembered.headerRowIndex] ?? []);
    if (signatureMatches(remembered.headerSignature, sigAtRow)) {
      return { headerRowIndex: remembered.headerRowIndex, confident: true, reused: true };
    }
  }
  const detected = detectHeaderRowIndex(rawRows);
  return { headerRowIndex: detected.index, confident: detected.confident, reused: false };
}

/** The processing path's ONLY interaction with header rows: does the
 *  freshly-refetched file's row at this EXACT index still hold this
 *  EXACT signature? No detection, no fallback — a mismatch means the
 *  file changed or the confirmed row no longer applies, and the caller
 *  must refuse rather than guess. */
export function verifyHeaderSignature(rawRows: string[][], headerRowIndex: number, expectedSignature: string[]): boolean {
  if (headerRowIndex < 0 || headerRowIndex >= rawRows.length) return false;
  return signatureMatches(expectedSignature, computeHeaderSignature(rawRows[headerRowIndex] ?? []));
}

// ---------------------------------------------------------------------
// Column display — letter + header + sample values, never a bare index
// ---------------------------------------------------------------------

export interface ColumnPreview {
  index: number;
  letter: string;
  header: string;
  samples: string[];
}

export function sheetColumnCount(rawRows: string[][]): number {
  return rawRows.reduce((max, r) => Math.max(max, r.length), 0);
}

export function buildColumnPreview(rawRows: string[][], headerRowIndex: number, maxSamples = 3): ColumnPreview[] {
  const headerRow = rawRows[headerRowIndex] ?? [];
  const columnCount = sheetColumnCount(rawRows);
  const columns: ColumnPreview[] = [];
  for (let i = 0; i < columnCount; i++) {
    const header = String(headerRow[i] ?? "").trim();
    const samples: string[] = [];
    for (let r = headerRowIndex + 1; r < rawRows.length && samples.length < maxSamples; r++) {
      const val = String(rawRows[r]?.[i] ?? "").trim();
      if (val) samples.push(val);
    }
    columns.push({ index: i, letter: excelColumnLetter(i), header, samples });
  }
  return columns;
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

/** Best-guess mapping from one header row's text — never auto-applied
 *  on its own; always shown to the operator for confirmation. */
export function suggestColumnMapping(headerRow: string[]): SupplierColumnMapping["columnMap"] {
  const map: SupplierColumnMapping["columnMap"] = {};
  const used = new Set<number>();

  for (const [field, pattern] of KEYWORD_RULES) {
    const idx = headerRow.findIndex((h, i) => !used.has(i) && pattern.test(normalizeHeader(h)));
    if (idx !== -1) {
      map[field] = idx;
      used.add(idx);
    }
  }
  return map;
}

// ---------------------------------------------------------------------
// Junk-row filtering + sanity checks — the actual fix for "6,500+ bad
// Match Review entries." Applied identically by parse-preview (to show
// an honest count/preview) and by processing (as the authoritative,
// server-side re-check before anything is written) — see
// pricing-process.ts, which imports these same functions rather than
// reimplementing the rules.
// ---------------------------------------------------------------------

const FOOTER_PATTERNS = [/\btotal\b/, /\bsubtotal\b/, /\bgrand\s*total\b/, /\bcontinued\b/, /\bpage\s*\d+/, /\bnotes?:/];

/** Rejects a row with no real product identity (blank description/SKU/
 *  UPC), a row that's an exact repeat of the header (paginated export),
 *  or a row matching common footer/subtotal text. Applied BEFORE a row
 *  ever reaches matching — this is what stops blank/title/footer rows
 *  from becoming Supplier Offers. */
export function isLikelyProductRow(row: string[], columnMap: SupplierColumnMapping["columnMap"], headerSignature: string[]): boolean {
  const cell = (idx?: number) => (idx === undefined ? "" : (row[idx] ?? "").trim());
  const desc = cell(columnMap.description);
  const sku = cell(columnMap.supplierSku);
  const code = cell(columnMap.upc) || cell(columnMap.ean);
  if (desc.length <= 1 && sku.length === 0 && code.length === 0) return false;

  if (headerSignature.length > 0) {
    const rowSig = computeHeaderSignature(row);
    if (rowSig.length === headerSignature.length && rowSig.every((v, i) => v === headerSignature[i])) return false;
  }

  const combined = normalizeHeader(row.join(" "));
  if (FOOTER_PATTERNS.some((p) => p.test(combined))) return false;

  return true;
}

/** Strict numeric-cell parsing — the WHOLE cell (after stripping common
 *  currency symbols/codes, thousands separators, and whitespace) must
 *  look like a plain number, not just contain digits somewhere. This is
 *  deliberately stricter than "extract any digits found" — a real
 *  product description often contains numbers too ("...100 ml FR"),
 *  and accepting those as a price is exactly what let a swapped
 *  Price/Description mapping slip past validation undetected (confirmed
 *  directly: extracting digits from a description text still produced
 *  plausible-looking prices). A real price cell like " $79.00 " or
 *  "160.00" reduces cleanly to a bare number; a sentence never does. */
function parseNumericCell(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/[$€£₹]/g, "")
    .replace(/\b(usd|aed|eur|gbp|sar|qar)\b/gi, "")
    .replace(/,/g, "")
    .trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return parseFloat(cleaned);
}

/** Applies a confirmed mapping to raw data rows -> normalized
 *  SupplierRawRow[], filtering out non-product rows first. Missing/
 *  unmapped fields default sensibly (empty string, null quantity, "USD"
 *  currency) rather than throwing. */
export function applyColumnMapping(
  rows: string[][],
  columnMap: SupplierColumnMapping["columnMap"],
  headerSignature: string[] = []
): SupplierRawRow[] {
  const cell = (row: string[], idx: number | undefined): string => (idx === undefined ? "" : (row[idx] ?? "").trim());
  const productRows = rows.filter((row) => isLikelyProductRow(row, columnMap, headerSignature));

  return productRows.map((row) => {
    const price = parseNumericCell(cell(row, columnMap.price));
    const quantity = parseNumericCell(cell(row, columnMap.quantity));
    return {
      supplierSku: cell(row, columnMap.supplierSku),
      description: cell(row, columnMap.description),
      brand: cell(row, columnMap.brand),
      quantity: quantity !== null ? Math.round(quantity) : null,
      price: price ?? 0,
      currency: cell(row, columnMap.currency).toUpperCase() || "USD",
      upc: cell(row, columnMap.upc),
      ean: cell(row, columnMap.ean),
      category: cell(row, columnMap.category),
    };
  });
}

export function columnMapInBounds(columnMap: SupplierColumnMapping["columnMap"], columnCount: number): boolean {
  return Object.values(columnMap).every((idx) => idx === undefined || (idx >= 0 && idx < columnCount));
}

export interface SanityCheckResult {
  ok: boolean;
  totalRows: number;
  priceValidRatio: number;
  descriptionValidRatio: number;
  warnings: string[];
}

const MIN_VALID_RATIO = 0.5;

/** Deliberately never looks at row COUNT to decide validity — a real
 *  supplier catalog can legitimately have thousands of rows. Only the
 *  shape of the parsed data (does price look like a price, does
 *  description look like text) determines whether a mapping is
 *  trustworthy. `ok: false` means block processing, not just warn. */
export function computeSanityChecks(rows: SupplierRawRow[]): SanityCheckResult {
  const total = rows.length;
  if (total === 0) {
    return { ok: false, totalRows: 0, priceValidRatio: 0, descriptionValidRatio: 0, warnings: ["No product rows were found with this mapping — check the header row and column choices."] };
  }
  const priceValid = rows.filter((r) => r.price > 0).length;
  // A real description has actual words in it — requiring letters (not
  // just length) is what catches a Description column actually pointing
  // at a barcode/SKU column: a 13-digit barcode string is "long" but has
  // zero letters, confirmed directly as the gap that let a swapped
  // Price/Description mapping pass validation undetected before this.
  const descValid = rows.filter((r) => r.description.trim().length > 2 && /[a-zA-Z]{2,}/.test(r.description)).length;
  const priceRatio = priceValid / total;
  const descRatio = descValid / total;

  const warnings: string[] = [];
  if (priceRatio < MIN_VALID_RATIO) {
    warnings.push(`Only ${Math.round(priceRatio * 100)}% of rows have a valid price — check the Price column mapping.`);
  }
  if (descRatio < MIN_VALID_RATIO) {
    warnings.push(`Only ${Math.round(descRatio * 100)}% of rows have a real description — check the Description column mapping.`);
  }
  return { ok: warnings.length === 0, totalRows: total, priceValidRatio: priceRatio, descriptionValidRatio: descRatio, warnings };
}
