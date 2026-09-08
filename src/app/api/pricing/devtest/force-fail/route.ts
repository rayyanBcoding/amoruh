import { NextResponse } from "next/server";
import { getUpload, updateUploadProgress } from "@/lib/pricing-db";
import { getSuppliers } from "@/lib/intake-db";

export const dynamic = "force-dynamic";

// TEMPORARY: forces a COMPLETED test upload's status back to "failed" so
// it can be retried through the real endpoint, to directly measure
// whether a retry duplicates its own history snapshots. Test-only,
// guarded to TEST_PRICING_ suppliers, removed before merge.
export async function POST(req: Request) {
  const { uploadId } = (await req.json().catch(() => ({}))) as { uploadId?: string };
  if (!uploadId) return NextResponse.json({ error: "Missing uploadId" }, { status: 400 });

  const upload = await getUpload(uploadId);
  if (!upload) return NextResponse.json({ error: "Upload not found" }, { status: 404 });

  const suppliers = await getSuppliers();
  const supplier = suppliers.find((s) => s.id === upload.supplierId);
  if (!supplier || !supplier.name.startsWith("TEST_PRICING_")) {
    return NextResponse.json({ error: "Refusing — not a TEST_PRICING_ supplier's upload." }, { status: 400 });
  }

  await updateUploadProgress(uploadId, { status: "failed", error: "forced by devtest" });
  return NextResponse.json({ ok: true });
}
