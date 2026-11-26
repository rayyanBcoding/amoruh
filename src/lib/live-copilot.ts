import type { Product } from "./types";
import type { CurrentProductFinancialsView } from "../context/LiveSessionContext";
import type { ReorderRow } from "./reorder-intelligence";
import { BUCKETS, MIN_APPLICABLE_LIVES_FOR_CONFIDENCE, MIN_UNITS_FOR_CONFIDENCE, TARGET_GROSS_MARGIN } from "./reorder-config";
import { getLiveNotesView } from "./live-notes";
import { isVerifiedRetail } from "./retail-reference";

export type CopilotHistory = { state: "ready" | "loading" | "unavailable"; row: ReorderRow | null };
export type CopilotStatus = { label: string; reason: string; tone: "warn" | "good" | "muted" };

// Advisory per-unit floor for the ACTUAL stocked item. Reuse Reorder's gross
// margin target (cost-only gross margin, not a promise of net margin after fees).
// Selling fees/fixed costs are already included in the existing break-even.
export function advisoryFloor(product: Pick<Product, "minPrice">, financials: CurrentProductFinancialsView | null) {
  const cost = financials?.cost;
  const breakEven = financials?.breakEven.status === "ok" ? financials.breakEven.breakEven : null;
  if (financials?.costSource === "unavailable" || cost == null || !Number.isFinite(cost) || cost <= 0 || breakEven == null || !Number.isFinite(breakEven) || breakEven <= 0 ||
      !Number.isFinite(product.minPrice) || product.minPrice < 0 || TARGET_GROSS_MARGIN < 0 || TARGET_GROSS_MARGIN >= 1) return null;
  const marginFloor = cost / (1 - TARGET_GROSS_MARGIN);
  const value = Math.ceil(Math.max(product.minPrice, breakEven, marginFloor));
  return { value, marginFloor, breakEven, cost, minimum: product.minPrice, targetMargin: TARGET_GROSS_MARGIN };
}

export function copilotView(product: Product, financials: CurrentProductFinancialsView | null, history: CopilotHistory) {
  const notes = getLiveNotesView(product);
  const notesNeedReview = !!notes?.check || !!product.liveNotes?.check;
  const keyNotes = (notes?.keyNotes ?? []).map((n) => n.trim()).filter(Boolean).slice(0, 3);
  const retail = isVerifiedRetail(product) ? product.retailReference! : null;
  const floor = advisoryFloor(product, financials);
  // Never apply another product's asynchronous history to the scanned item.
  const row = history.state === "ready" && history.row?.productId === product.id ? history.row : null;
  const enough = !!row && row.units >= MIN_UNITS_FOR_CONFIDENCE && row.applicableLives >= MIN_APPLICABLE_LIVES_FOR_CONFIDENCE;
  let status: CopilotStatus;
  const historicalRisk = row && row.units > 0 && (row.bucket === "High Demand / Losing Money" || row.bucket === "High Demand / Thin Margin" ||
    (row.margin !== null && row.margin < TARGET_GROSS_MARGIN) || (floor && row.avgSellingPrice < floor.value));
  const currentPriceRisk = floor && ((product.lootPrice > 0 && product.lootPrice < floor.value) ||
    (product.minPrice > 0 && product.minPrice < Math.max(floor.breakEven, floor.marginFloor)));
  if (historicalRisk || currentPriceRisk) {
    status = { label: "⚠️ Protect price", tone: "warn", reason: historicalRisk
      ? "Recent real LIVE sales have thin/negative gross margin or averaged below this item's advisory floor."
      : "The configured minimum or current LIVE price is below this item's cost-based advisory floor." };
  } else if (!floor || !retail || notesNeedReview || !keyNotes.length || !product.concentration.trim() ||
      !Number.isFinite(product.inventory) || product.inventory <= 0 || financials?.costSource !== "weighted_landed" ||
      history.state !== "ready" || row?.costUnknown || (row && row.costCoverage < 1)) {
    const reasons = [!floor && "Cost, fees/break-even or minimum-price data needs review.", !retail && "Retail reference is not currently verified.",
      notesNeedReview && "Notes are flagged: check before quoting.", !keyNotes.length && "Scent notes are missing.",
      !product.concentration.trim() && "Concentration is missing.",
      (!Number.isFinite(product.inventory) || product.inventory <= 0) && "Stock is unavailable or invalid.",
      financials?.costSource === "legacy" && "Cost uses the legacy fallback rather than remaining inventory lots.",
      history.state !== "ready" && "Real LIVE history is loading or unavailable; seller performance is not assumed.",
      row && (row.costUnknown || row.costCoverage < 1) && "Historical cost coverage is incomplete; check the history details."];
    status = { label: "⚠️ Data review", tone: "warn", reason: reasons.filter(Boolean).join(" ") };
  } else if (product.inventory <= 3) {
    status = { label: "📦 Low stock", tone: "warn", reason: `Only ${product.inventory} units ${product.inventory === 1 ? "remains" : "remain"}.` };
  } else if (enough && row?.bucket === "Hot + Profitable") {
    status = { label: "🔥 Strong seller", tone: "good", reason: "Hot + Profitable in Reorder Intelligence's last-five-real-LIVEs window, with its existing evidence thresholds." };
  } else if (enough && row?.bucket === "Weak Performer" && row.breakdown.demand < 100 - BUCKETS.hotDemandMin) {
    // Weak Performer alone can mean poor profitability, not slow demand. Only
    // use the low-demand tail (inverse of Reorder's hot-demand cutoff) here.
    status = { label: "🐌 Slow mover", tone: "muted", reason: "Reorder Weak Performer with demand below the 30th percentile in the last five real LIVEs; minimum history thresholds are met." };
  } else {
    status = { label: "✅ Good to run", tone: "good", reason: enough
      ? "Current data passes the checks; no higher-priority price, data or stock warning applies."
      : "Current data passes the checks. There is not enough recent evidence to assign a seller-performance label." };
  }
  const name = product.name.toLowerCase().startsWith(product.brand.toLowerCase()) ? product.name : `${product.brand} ${product.name}`;
  const concentration = ({ "Eau de Toilette": "EDT", "Eau de Parfum": "EDP", "Extrait de Parfum": "Extrait" } as Record<string, string>)[product.concentration] ?? product.concentration;
  return { name, concentration, keyNotes, notesNeedReview, retail, floor, status, history: row };
}
