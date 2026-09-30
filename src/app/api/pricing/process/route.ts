import { NextResponse } from "next/server";
import { getSupplier, updateSupplier } from "@/lib/intake-db";
import { processSupplierUploadBatch, ProcessSessionExpiredError } from "@/lib/pricing-process";
import type { SupplierColumnMapping } from "@/lib/intake-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Body {
  supplierId?: string;
  blobUrl?: string;
  filename?: string;
  uploadType?: "full" | "partial";
  headerRowIndex?: number;
  headerSignature?: string[];
  columnMap?: SupplierColumnMapping["columnMap"];
  /** Retry a specific failed upload by id — see processSupplierUploadBatch. */
  retryUploadId?: string;
  /** Row offset already processed. Omit/0 to start a new upload. */
  cursor?: number;
  /** Returned by the previous call in this same upload — omit to start
   *  fresh. An expired/out-of-sync session returns 410; the client
   *  restarts from cursor 0, exactly like parse-preview/match-batch. */
  sessionId?: string;
}

// POST /api/pricing/process — applies EXACTLY the mapping the operator
// confirmed in Preview (headerRowIndex + headerSignature + columnMap),
// in bounded, resumable batches (processSupplierUploadBatch — see its
// own comment for why: the matching/auto-create-eligibility loop this
// route used to run in one shot could exceed Vercel's function timeout
// on a large or brand-recognition-heavy supplier file, confirmed
// directly against a real 3,094-row file). This route never detects or
// suggests anything itself — that only ever happens in
// /api/pricing/parse-preview. Every call independently re-fetches the
// file and verifies the confirmed header row/signature still match, then
// re-runs the same sanity checks Preview showed, before writing
// anything.
//
// The expensive persist/index/commit step — the one that actually
// publishes a new supplier generation — only ever runs on the batch that
// finishes the file. A partial generation can never go live: every
// earlier batch only touches a short-lived staging session and the
// upload record's own progress fields, exactly like a normal in-progress
// upload already looked before this change.
export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (
    !body.supplierId ||
    !body.blobUrl ||
    !body.uploadType ||
    body.headerRowIndex === undefined ||
    !body.headerSignature ||
    !body.columnMap
  ) {
    return NextResponse.json({ error: "Missing required fields — headerRowIndex, headerSignature, and columnMap must all be the exact configuration confirmed in Preview." }, { status: 400 });
  }
  const cursor = body.cursor ?? 0;

  const supplier = await getSupplier(body.supplierId);
  if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
  if (supplier.status === "archived") {
    return NextResponse.json(
      { error: `Supplier "${supplier.name}" is archived — restore it before uploading a new price list.` },
      { status: 409 }
    );
  }

  // Persist the confirmed triple as the remembered mapping — only on the
  // FIRST call of this upload; every later batch reuses the exact same
  // values the client keeps sending, so there's nothing new to persist.
  if (!body.sessionId) {
    const confirmedMapping: SupplierColumnMapping = {
      headerRowIndex: body.headerRowIndex,
      headerSignature: body.headerSignature,
      columnMap: body.columnMap,
      confirmedAt: new Date().toISOString(),
    };
    const mappingChanged =
      !supplier.columnMapping ||
      supplier.columnMapping.headerRowIndex !== confirmedMapping.headerRowIndex ||
      JSON.stringify(supplier.columnMapping.headerSignature) !== JSON.stringify(confirmedMapping.headerSignature) ||
      JSON.stringify(supplier.columnMapping.columnMap) !== JSON.stringify(confirmedMapping.columnMap);
    if (mappingChanged || supplier.defaultUploadType !== body.uploadType) {
      await updateSupplier(supplier.id, { columnMapping: confirmedMapping, defaultUploadType: body.uploadType });
    }
  }

  try {
    const result = await processSupplierUploadBatch({
      supplierId: supplier.id,
      filename: body.filename ?? "price-list",
      blobUrl: body.blobUrl,
      uploadType: body.uploadType,
      headerRowIndex: body.headerRowIndex,
      headerSignature: body.headerSignature,
      columnMap: body.columnMap,
      retryUploadId: body.retryUploadId,
      cursor,
      sessionId: body.sessionId,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ProcessSessionExpiredError) {
      return NextResponse.json({ error: err.message, sessionExpired: true }, { status: 410 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not process this upload." }, { status: 500 });
  }
}
