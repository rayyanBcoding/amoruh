import { NextResponse } from "next/server";
import { getSellingConfig, updateSellingConfig, SellingConfigError } from "@/lib/live-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = await getSellingConfig();
    return NextResponse.json({ config });
  } catch (err) {
    return NextResponse.json(
      { error: `Could not load selling config: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    );
  }
}

// PATCH /api/live/selling-config { platformFeePercent?, paymentFeePercent?,
// shippingSubsidy?, packagingCost?, operator? } — validated server-side,
// never just at display time. See updateSellingConfig() in live-db.ts.
export async function PATCH(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const config = await updateSellingConfig({
      platformFeePercent: body?.platformFeePercent === undefined ? undefined : body.platformFeePercent,
      paymentFeePercent: body?.paymentFeePercent === undefined ? undefined : body.paymentFeePercent,
      shippingSubsidy: body?.shippingSubsidy === undefined ? undefined : body.shippingSubsidy,
      packagingCost: body?.packagingCost === undefined ? undefined : body.packagingCost,
      operator: typeof body?.operator === "string" ? body.operator : "Unknown",
    });
    return NextResponse.json({ config });
  } catch (err) {
    const status = err instanceof SellingConfigError ? 400 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not update selling config." },
      { status }
    );
  }
}
