// ---------------------------------------------------------------------
// "Continue without AI": manual purchase-order entry on the normal Review
// screen, used when invoice extraction is unavailable (e.g. the AI service
// account needs credits).
//
// Everything here is pure, in-memory state — nothing in this file talks to
// the network or the database. A PO only comes into existence when the
// operator confirms the Review screen and the existing POST /api/intake/pos
// flow runs, exactly as for an AI-extracted invoice. Inventory, lots and
// the ledger are never touched by manual entry; they only change at
// receiving, as always.
// ---------------------------------------------------------------------

import { matchLineItem } from "./intake-matching";
import type { ExtractedPO, MatchedLineItem } from "./intake-types";
import type { Product } from "./types";
import type { InvoiceExtractionErrorCode } from "./intake-ai-errors";

/** Failure codes after which the operator may still enter the PO by hand. */
const MANUAL_FALLBACK_CODES: ReadonlySet<string> = new Set<InvoiceExtractionErrorCode>([
  "ai_credits_exhausted",
  "ai_auth_failed",
  "ai_rate_limited",
  "ai_overloaded",
  "ai_unreachable",
  "ai_not_configured",
  "invoice_unreadable",
  "ai_unexpected_error",
]);

export function canContinueWithoutAI(code: string | null | undefined): boolean {
  return Boolean(code && MANUAL_FALLBACK_CODES.has(code));
}

/** Local calendar date (not UTC — an evening in New York is already
 *  "tomorrow" in UTC), as YYYY-MM-DD. */
export function todayLocalISO(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface ManualDraft {
  extracted: ExtractedPO;
  lines: MatchedLineItem[];
  /** One entry per line: the confirmed product id, or null (unmatched). */
  resolved: (string | null)[];
}

export function blankManualLine(): MatchedLineItem {
  return {
    rawDescription: "",
    upc: "",
    brand: "",
    name: "",
    size: "",
    concentration: "",
    quantity: 1,
    unitCost: 0,
    lineTotal: 0,
    matchType: "unmatched",
    candidate: null,
  };
}

/** Empty draft: today's date, USD, no lines. */
export function createEmptyManualDraft(now: Date = new Date()): ManualDraft {
  return {
    extracted: { poNumber: "", supplierName: "", invoiceDate: todayLocalISO(now), currency: "USD", lineItems: [] },
    lines: [],
    resolved: [],
  };
}

export function addManualLine(draft: ManualDraft): ManualDraft {
  return { ...draft, lines: [...draft.lines, blankManualLine()], resolved: [...draft.resolved, null] };
}

export function removeManualLine(draft: ManualDraft, index: number): ManualDraft {
  return {
    ...draft,
    lines: draft.lines.filter((_, i) => i !== index),
    resolved: draft.resolved.filter((_, i) => i !== index),
  };
}

export type ManualLineEdit = Partial<Pick<MatchedLineItem, "rawDescription" | "upc" | "quantity" | "unitCost">>;

const isExact = (t: MatchedLineItem["matchType"]) => t === "upc" || t === "sku";

/** Applies one field edit to a manual line and re-runs the EXISTING product
 *  matching (matchLineItem) when the identifying text changed.
 *
 *  - The "UPC / SKU" box feeds the existing UPC match directly, and is also
 *    shown to the existing SKU match (which looks for one of our SKUs inside
 *    the line text), so typing either an exact barcode or an exact SKU works.
 *  - Only an EXACT UPC/SKU hit auto-selects a product. A fuzzy hit stays a
 *    suggestion the operator must accept; an unmatched line stays unmatched.
 *  - A product the operator picked by hand is never overwritten by a re-match;
 *    an earlier AUTO-selection is cleared if the text no longer matches.
 */
export function applyManualLineEdit(draft: ManualDraft, index: number, edit: ManualLineEdit, products: Product[]): ManualDraft {
  const prev = draft.lines[index];
  if (!prev) return draft;
  const next: MatchedLineItem = { ...prev, ...edit };
  next.quantity = Number.isFinite(next.quantity) ? next.quantity : 0;
  next.unitCost = Number.isFinite(next.unitCost) ? next.unitCost : 0;
  next.lineTotal = Math.round(next.quantity * next.unitCost * 100) / 100;

  const identityChanged = edit.rawDescription !== undefined || edit.upc !== undefined;
  let resolved = draft.resolved[index];
  if (identityChanged) {
    // The existing matcher reads brand/name/size/concentration for its fuzzy
    // suggestion (AI extraction fills those in), so a manual line offers the
    // typed description as the name — for matching only; the saved line keeps
    // exactly what the operator typed.
    const probe = matchLineItem(
      { ...next, name: next.name || next.rawDescription, rawDescription: `${next.rawDescription} ${next.upc}`.trim() },
      products
    );
    next.matchType = probe.matchType;
    next.candidate = probe.candidate;
    if (isExact(probe.matchType)) {
      resolved = probe.candidate?.productId ?? null;
    } else if (isExact(prev.matchType)) {
      resolved = null; // the earlier auto-match no longer applies
    }
  }

  return {
    ...draft,
    lines: draft.lines.map((l, i) => (i === index ? next : l)),
    resolved: draft.resolved.map((r, i) => (i === index ? resolved : r)),
  };
}

/** The dropdown / "Use suggestion" choice for one line. */
export function selectProductForLine(draft: ManualDraft, index: number, productId: string | null): ManualDraft {
  return { ...draft, resolved: draft.resolved.map((r, i) => (i === index ? productId : r)) };
}

/** What stops the operator from confirming. Blocking a blank supplier matters:
 *  the PO flow would otherwise create a supplier with an empty name. */
export function validateManualDraft(draft: ManualDraft): string[] {
  const problems: string[] = [];
  if (!draft.extracted.supplierName.trim()) problems.push("Enter the supplier name.");
  if (!draft.extracted.poNumber.trim()) problems.push("Enter the PO / invoice number.");
  if (draft.lines.length === 0) problems.push("Add at least one line.");
  draft.lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.rawDescription.trim()) problems.push(`Line ${n}: enter a description.`);
    if (!Number.isInteger(l.quantity) || l.quantity <= 0) problems.push(`Line ${n}: quantity must be a whole number above 0.`);
    if (!(l.unitCost >= 0)) problems.push(`Line ${n}: unit cost can't be negative.`);
  });
  return problems;
}

/** Exactly the body the existing POST /api/intake/pos expects. */
export function buildCreatePOBody(draft: ManualDraft, blobUrl: string, filename: string) {
  return { extracted: draft.extracted, lines: draft.lines, resolvedProductIds: draft.resolved, blobUrl, filename };
}
