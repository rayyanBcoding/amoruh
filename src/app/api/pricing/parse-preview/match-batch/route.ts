import { NextResponse } from "next/server";
import { getSupplier } from "@/lib/intake-db";
import { getProducts } from "@/lib/db";
import {
  getAliasesForSupplier,
  getAllReferenceProducts,
  getUploadsForSupplier,
  getPreviewMatchSession,
  createPreviewMatchSession,
  savePreviewMatchSession,
  deletePreviewMatchSession,
} from "@/lib/pricing-db";
import { assessImportAnomalyRisk } from "@/lib/pricing-process";
import { createEmptyMatchPreviewBatchState, stepMatchPreviewBatch, type MatchPreviewBatchState } from "@/lib/pricing-matching";
import { applyColumnMapping, parseSpreadsheetRaw, verifyHeaderSignature } from "@/lib/pricing-parse";
import type { SupplierColumnMapping } from "@/lib/intake-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Measured against the real production catalog (~15,000 reference
// products) on 2026-09-29 — see scripts/measure-baseline-matching-costs.ts.
// Worst case (brand not recognized -> narrowPoolForRow falls back to
// scoring the FULL candidate pool per row, confirmed as the actual root
// cause of the Classic Wholesale timeout) measured 22.48ms/row; the
// normal known-brand case measured 2.53ms/row. 500 rows/batch is
// ~11.2s worst case, ~1.3s typical — comfortably under the 60s function
// limit even after adding blob re-fetch/re-parse and catalog-read
// overhead (~2-3s), not just barely under it.
const BATCH_SIZE = 500;

interface Body {
  supplierId?: string;
  blobUrl?: string;
  headerRowIndex?: number;
  headerSignature?: string[];
  columnMap?: SupplierColumnMapping["columnMap"];
  /** Row offset to resume from. 0 (or omitted) starts a fresh session. */
  cursor?: number;
  /** Returned by the previous call in this same matching pass — omit to
   *  start fresh. If the session has expired (TTL) or doesn't match the
   *  given cursor, this route returns 410 and the client restarts from
   *  cursor 0 rather than guessing at a resume point. */
  sessionId?: string;
}

// POST /api/pricing/parse-preview/match-batch — the resumable-batch
// twin of parse-preview's (now removed) full-file matching pass. Same
// exact headerRowIndex/columnMap contract as parse-preview and /process:
// this route never re-detects a mapping, only re-verifies the one it's
// given still matches the file (same verifyHeaderSignature check
// /process uses), so the SAME mapping is used start to finish across
// every batch and later into the real commit. Never writes a supplier
// offer or Master Product — the only Redis write is the throwaway,
// short-TTL matching-session cache (see pricing-db.ts's
// createPreviewMatchSession/savePreviewMatchSession).
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.supplierId || !body.blobUrl || body.headerRowIndex === undefined || !body.headerSignature || !body.columnMap) {
    return NextResponse.json({ error: "Missing required fields — headerRowIndex, headerSignature, and columnMap must be the exact configuration confirmed in Preview." }, { status: 400 });
  }
  const cursor = body.cursor ?? 0;

  const supplier = await getSupplier(body.supplierId);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });

  const blobRes = await fetch(body.blobUrl);
  if (!blobRes.ok) return NextResponse.json({ error: "Could not download the uploaded file." }, { status: 400 });
  let rawRows: string[][];
  try {
    rawRows = parseSpreadsheetRaw(await blobRes.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Could not read this file — is it a valid Excel or CSV file?" }, { status: 400 });
  }
  if (!verifyHeaderSignature(rawRows, body.headerRowIndex, body.headerSignature)) {
    return NextResponse.json({ error: "Confirmed mapping no longer matches this file's header row — return to Preview and review the spreadsheet mapping." }, { status: 400 });
  }
  const dataRows = rawRows.slice(body.headerRowIndex + 1);
  const parsedRows = applyColumnMapping(dataRows, body.columnMap, body.headerSignature);
  const totalRows = parsedRows.length;

  // Resolve the resumable state — either a fresh one (cursor 0, no
  // sessionId) or the one saved by the previous batch in this same pass.
  let state: MatchPreviewBatchState;
  if (body.sessionId) {
    const existing = await getPreviewMatchSession(body.sessionId);
    if (!existing || existing.cursor !== cursor) {
      return NextResponse.json(
        { error: "This preview matching session has expired or is out of sync — restart matching from the beginning.", sessionExpired: true },
        { status: 410 }
      );
    }
    state = existing.state;
  } else {
    if (cursor !== 0) {
      return NextResponse.json({ error: "A cursor without a sessionId must be 0 — restart matching from the beginning.", sessionExpired: true }, { status: 410 });
    }
    state = createEmptyMatchPreviewBatchState();
  }

  const batch = parsedRows.slice(cursor, cursor + BATCH_SIZE);
  const [products, aliases, referenceProducts] = await Promise.all([
    getProducts(),
    getAliasesForSupplier(body.supplierId),
    getAllReferenceProducts(),
  ]);
  stepMatchPreviewBatch(batch, products, aliases, referenceProducts, state, body.supplierId);

  const nextCursor = cursor + batch.length;
  const done = nextCursor >= totalRows;

  const runningTotals = {
    totalRows,
    matchedProduct: state.matchedProduct,
    matchedReferenceProduct: state.matchedReferenceProduct,
    proposedNewMasterProducts: state.proposedNewMasterProducts,
    requiresReview: state.requiresReview,
    nonProductRows: state.nonProductRows,
  };

  if (done) {
    let importAnomaly = null;
    try {
      const priorUploads = await getUploadsForSupplier(body.supplierId, 10);
      importAnomaly = assessImportAnomalyRisk(runningTotals, priorUploads);
    } finally {
      if (body.sessionId) await deletePreviewMatchSession(body.sessionId);
    }
    return NextResponse.json({ sessionId: null, cursor: nextCursor, totalRows, done: true, runningTotals, importAnomaly });
  }

  const sessionId = body.sessionId
    ? await (async () => {
        await savePreviewMatchSession(body.sessionId!, state, nextCursor);
        return body.sessionId!;
      })()
    : await createPreviewMatchSession(state, nextCursor);

  return NextResponse.json({ sessionId, cursor: nextCursor, totalRows, done: false, runningTotals, importAnomaly: null });
}
