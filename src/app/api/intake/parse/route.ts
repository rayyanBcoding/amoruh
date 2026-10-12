import { handleParseInvoice } from "@/lib/intake-parse-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/intake/parse — takes a blob URL just uploaded via
// /api/intake/upload, extracts a structured PO from it with Claude, and
// runs product matching. Returns a preview only — nothing is persisted
// until the operator confirms on the Review screen (POST /api/intake/pos).
export async function POST(req: Request) {
  return handleParseInvoice(req);
}
