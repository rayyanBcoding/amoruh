// Orchestrates the full remaining-inventory selling-notes enrichment run
// in safe, fixed-size batches — the approved bulk continuation of
// scripts/enrich-fragrance-selling-notes.ts's 5-product test. Reuses that
// script's researchProduct function directly (same research rules, same
// prompt, same JSON contract) rather than re-implementing anything.
//
// SAFETY:
//  - Snapshots the eligible target list ONCE at the very start (inventory
//    > 0 AND missing real sellingKeyNotes/sellingQuickLine — see
//    needsSellingNotesResearch). Immediately before writing each
//    individual product, re-reads its CURRENT inventory fresh and skips
//    the write (without discarding the research already done) if
//    inventory has dropped to 0 since the snapshot was taken — this is
//    the "skipped because inventory was no longer > 0" case in the final
//    report.
//  - Writes ONLY the 7 selling-reference fields per product, exactly as
//    enrich-fragrance-selling-notes.ts does — never inventory, cost,
//    price, lots, POs, sales, fragranceNotes, manualSellingNote, or
//    internal notes.
//  - Processes BATCH_SIZE products at a time, sequentially within a
//    batch (never concurrent web-search calls), with a short pause
//    between batches — "safe batches, not one uncontrolled pass."
//  - Never imports or touches anything from the live-session/Go Live
//    code path.
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getProducts, updateProduct } from "../src/lib/db";
import { needsSellingNotesResearch } from "../src/lib/selling-notes";
import { researchProduct } from "./enrich-fragrance-selling-notes";
import type { Product } from "../src/lib/types";

const BATCH_SIZE = 8;
const PAUSE_BETWEEN_BATCHES_MS = 3000;
const SELLING_FIELDS = new Set(["sellingKeyNotes", "sellingScentProfile", "sellingQuickLine", "sellingNotesSourceName", "sellingNotesSourceUrl", "sellingNotesResearchedAt", "sellingNotesStatus"]);

interface AttemptRecord {
  id: string;
  brand: string;
  name: string;
  size: string;
  concentration: string;
  upc: string;
  outcome: "completed" | "insufficient_confidence" | "skipped_out_of_stock";
  sourceType?: "official" | "fallback" | "";
  sourceName?: string;
  sourceUrl?: string;
  reason?: string;
  otherFieldsChanged: string[];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const client = new Anthropic();
  const startProducts = await getProducts();
  const targets = startProducts.filter(needsSellingNotesResearch);

  console.log(`Snapshot: ${targets.length} eligible products (inventory > 0, missing real selling notes) out of ${startProducts.length} total.`);
  console.log(`Processing in batches of ${BATCH_SIZE}.\n`);

  const records: AttemptRecord[] = [];

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    console.log(`--- Batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(targets.length / BATCH_SIZE)} (products ${i + 1}-${Math.min(i + BATCH_SIZE, targets.length)} of ${targets.length}) ---`);

    for (const snapshotProduct of batch) {
      // Re-read fresh — this specific product may have been sold since
      // the snapshot was taken at the top of this run.
      const currentProducts = await getProducts();
      const current = currentProducts.find((p) => p.id === snapshotProduct.id);
      if (!current || current.inventory <= 0) {
        console.log(`SKIP (no longer in stock): ${snapshotProduct.brand} ${snapshotProduct.name} (${snapshotProduct.id}), UPC ${snapshotProduct.barcode}`);
        records.push({
          id: snapshotProduct.id,
          brand: snapshotProduct.brand,
          name: snapshotProduct.name,
          size: snapshotProduct.size,
          concentration: snapshotProduct.concentration,
          upc: snapshotProduct.barcode,
          outcome: "skipped_out_of_stock",
          otherFieldsChanged: [],
        });
        continue;
      }
      // Also re-check it isn't already complete (e.g. a concurrent run
      // already handled it) — content-based, same rule as eligibility.
      if (current.sellingKeyNotes && current.sellingKeyNotes.length > 0 && current.sellingQuickLine) {
        console.log(`SKIP (already complete since snapshot): ${current.brand} ${current.name} (${current.id})`);
        continue;
      }

      const before = { ...current };
      console.log(`Researching: ${current.brand} ${current.name} (${current.id}) | ${current.size} ${current.concentration} | UPC ${current.barcode}`);
      const result = await researchProduct(client, current);

      const patch: Partial<Product> = result.identified
        ? {
            sellingKeyNotes: result.keyNotes,
            sellingScentProfile: result.scentProfile,
            sellingQuickLine: result.quickSellingLine,
            sellingNotesSourceName: result.sourceName,
            sellingNotesSourceUrl: result.sourceUrl,
            sellingNotesResearchedAt: new Date().toISOString(),
            sellingNotesStatus: "complete",
          }
        : {
            sellingNotesResearchedAt: new Date().toISOString(),
            sellingNotesStatus: "insufficient_confidence",
          };

      const updated = await updateProduct(current.id, patch);
      const otherFieldsChanged = updated
        ? (Object.keys(updated) as (keyof Product)[]).filter((k) => !SELLING_FIELDS.has(k) && JSON.stringify(updated[k]) !== JSON.stringify(before[k]))
        : [];

      if (result.identified) {
        console.log(`  -> COMPLETE (${result.sourceType || "unknown source type"}): ${result.keyNotes.join(" · ")}`);
      } else {
        console.log(`  -> INSUFFICIENT CONFIDENCE: ${result.reason}`);
      }
      if (otherFieldsChanged.length > 0) {
        console.log(`  *** WARNING: unexpected field changes: ${otherFieldsChanged.join(", ")} ***`);
      }

      records.push({
        id: current.id,
        brand: current.brand,
        name: current.name,
        size: current.size,
        concentration: current.concentration,
        upc: current.barcode,
        outcome: result.identified ? "completed" : "insufficient_confidence",
        sourceType: result.sourceType,
        sourceName: result.sourceName,
        sourceUrl: result.sourceUrl,
        reason: result.reason,
        otherFieldsChanged,
      });
    }

    if (i + BATCH_SIZE < targets.length) {
      console.log(`Pausing ${PAUSE_BETWEEN_BATCHES_MS}ms before next batch...\n`);
      await sleep(PAUSE_BETWEEN_BATCHES_MS);
    }
  }

  const completed = records.filter((r) => r.outcome === "completed");
  const insufficient = records.filter((r) => r.outcome === "insufficient_confidence");
  const skipped = records.filter((r) => r.outcome === "skipped_out_of_stock");
  const official = completed.filter((r) => r.sourceType === "official");
  const fallback = completed.filter((r) => r.sourceType === "fallback");
  const anyOtherFieldChanges = records.filter((r) => r.otherFieldsChanged.length > 0);

  console.log("\n=== SUMMARY ===");
  console.log(`Total attempted (research actually run): ${completed.length + insufficient.length}`);
  console.log(`Total completed: ${completed.length}`);
  console.log(`Total insufficient-confidence: ${insufficient.length}`);
  console.log(`Total skipped (no longer in stock): ${skipped.length}`);
  console.log(`Source breakdown: official=${official.length}, fallback=${fallback.length}, unclassified=${completed.length - official.length - fallback.length}`);
  console.log(`Records with unexpected non-selling-reference field changes: ${anyOtherFieldChanges.length}`);

  if (insufficient.length > 0) {
    console.log("\nInsufficient-confidence products:");
    for (const r of insufficient) console.log(`  ${r.brand} ${r.name} | ${r.size} ${r.concentration} | UPC ${r.upc} | reason: ${r.reason}`);
  }
  if (skipped.length > 0) {
    console.log("\nSkipped (no longer in stock):");
    for (const r of skipped) console.log(`  ${r.brand} ${r.name} | UPC ${r.upc}`);
  }

  const outDir = path.resolve(__dirname, "..", "backups");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `selling-notes-bulk-enrichment-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        takenAt: new Date().toISOString(),
        eligibleAtStart: targets.length,
        totalAttempted: completed.length + insufficient.length,
        totalCompleted: completed.length,
        totalInsufficientConfidence: insufficient.length,
        totalSkippedOutOfStock: skipped.length,
        sourceBreakdown: { official: official.length, fallback: fallback.length },
        records,
      },
      null,
      2
    )
  );
  console.log(`\nFull report written to: ${outPath}`);
}
main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
