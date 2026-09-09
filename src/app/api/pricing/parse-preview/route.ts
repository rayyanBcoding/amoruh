import { NextResponse } from "next/server";
import { getSupplier } from "@/lib/intake-db";
import {
  applyColumnMapping,
  buildColumnPreview,
  computeHeaderSignature,
  computeSanityChecks,
  parseSpreadsheetRaw,
  resolveHeaderRow,
  suggestColumnMapping,
} from "@/lib/pricing-parse";
import type { SupplierColumnMapping } from "@/lib/intake-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HEADER_WINDOW_ROWS = 30;
const PREVIEW_ROW_COUNT = 20;

interface Body {
  supplierId?: string;
  blobUrl?: string;
  /** Operator override — omit to auto-detect / reuse the remembered row. */
  headerRowIndex?: number;
  /** Operator override — omit to reuse the remembered map (if the header
   *  row was reused) or suggest fresh from the resolved header row. */
  columnMap?: SupplierColumnMapping["columnMap"];
}

// POST /api/pricing/parse-preview — the full preview pass. Called once
// on upload, then AGAIN every time the operator changes the header row
// or any column choice, so the preview/counts/sanity check are never
// stale relative to what's actually selected. Never writes anything —
// see /api/pricing/process for the path that actually applies a
// confirmed mapping (and re-verifies it independently rather than
// trusting this response).
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (!body.supplierId || !body.blobUrl) {
    return NextResponse.json({ error: "Missing supplierId or blobUrl." }, { status: 400 });
  }

  const [supplier, blobRes] = await Promise.all([getSupplier(body.supplierId), fetch(body.blobUrl)]);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
  if (!blobRes.ok) return NextResponse.json({ error: "Could not download the uploaded file." }, { status: 400 });

  let rawRows: string[][];
  try {
    rawRows = parseSpreadsheetRaw(await blobRes.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Could not read this file — is it a valid Excel or CSV file?" }, { status: 400 });
  }
  if (rawRows.length === 0) {
    return NextResponse.json({ error: "This file appears to be empty." }, { status: 400 });
  }

  const remembered = supplier.columnMapping
    ? { headerRowIndex: supplier.columnMapping.headerRowIndex, headerSignature: supplier.columnMapping.headerSignature }
    : undefined;
  const headerResolution = resolveHeaderRow(rawRows, body.headerRowIndex, remembered);
  const headerRowIndex = headerResolution.headerRowIndex;
  const headerRow = rawRows[headerRowIndex] ?? [];
  const headerSignature = computeHeaderSignature(headerRow);

  const columnMap =
    body.columnMap ??
    (headerResolution.reused && supplier.columnMapping ? supplier.columnMapping.columnMap : suggestColumnMapping(headerRow));
  const mappingReused = headerResolution.reused && !body.columnMap;

  const dataRows = rawRows.slice(headerRowIndex + 1);
  const parsedRows = applyColumnMapping(dataRows, columnMap, headerSignature);
  const sanityCheck = computeSanityChecks(parsedRows);
  const columns = buildColumnPreview(rawRows, headerRowIndex);

  return NextResponse.json({
    headerRowWindow: rawRows.slice(0, HEADER_WINDOW_ROWS),
    detectedHeaderRowIndex: headerResolution.headerRowIndex,
    headerRowIndex,
    headerConfident: headerResolution.confident,
    headerSignature,
    mappingReused,
    columns,
    columnMap,
    previewRows: parsedRows.slice(0, PREVIEW_ROW_COUNT),
    totalProductRows: parsedRows.length,
    sanityCheck,
    defaultUploadType: supplier.defaultUploadType ?? "full",
  });
}
