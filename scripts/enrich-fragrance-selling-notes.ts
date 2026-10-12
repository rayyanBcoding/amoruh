// Researches and stores a short "selling reference" (key notes, scent
// profile, one-sentence quick line) for IN-STOCK Products only, via the
// Claude API's web_search server tool. See src/lib/selling-notes.ts for
// the eligibility rule (content-based, not timestamp-based — a product
// that was attempted but came back inconclusive stays eligible).
//
// SAFETY / SCOPE:
//  - Only ever calls updateProduct with a patch containing EXACTLY the
//    7 new selling-reference fields (sellingKeyNotes, sellingScentProfile,
//    sellingQuickLine, sellingNotesSourceName, sellingNotesSourceUrl,
//    sellingNotesResearchedAt, sellingNotesStatus). Never touches
//    inventory, cost, pricing, sku, barcode, or any other Product field.
//  - Never imports or calls anything from intake-db.ts (POs/receiving),
//    sales-analytics.ts (Sale records), or pricing-db.ts/pricing-process.ts
//    (PricingReferenceProduct / supplier matching) — structurally
//    incapable of touching any of those, not just instructed not to.
//  - Never writes manualSellingNote, fragranceNotes, topNotes,
//    middleNotes, baseNotes, description, or notes — those stay exactly
//    as an operator left them.
//  - Refuses to run without an explicit --ids=<comma-separated> list, or
//    --all with an explicit --limit (capped at MAX_UNSCOPED_LIMIT), so a
//    bare invocation can never silently process the full catalog.
//  - --dry-run prints the research result without writing anything.
//
// Research rules enforced in the prompt itself: identify the EXACT
// flanker/concentration/size (never guess a sibling variant), official
// brand/product page preferred, a reputable fragrance database only as
// fallback, max 3–5 key notes, max 2–3 profile descriptors, one concise
// quick-selling sentence. If confidence is insufficient, the model is
// instructed to say so explicitly rather than fabricate — recorded here
// as sellingNotesStatus: "insufficient_confidence" with no content
// written, never as a guess.
import Anthropic from "@anthropic-ai/sdk";
import { getProducts, updateProduct } from "../src/lib/db";
import { needsSellingNotesResearch } from "../src/lib/selling-notes";
import type { Product } from "../src/lib/types";

const MAX_UNSCOPED_LIMIT = 10;
const MODEL = "claude-opus-5";

export interface ResearchResult {
  identified: boolean;
  keyNotes: string[];
  scentProfile: string[];
  quickSellingLine: string;
  sourceName: string;
  sourceUrl: string;
  /** Self-reported by the model — which category of source it actually
   *  used, per the same official-first/fallback-second rule enforced in
   *  the prompt. Empty when identified is false. */
  sourceType: "official" | "fallback" | "";
  reason: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const idsArg = args.find((a) => a.startsWith("--ids="));
  const allFlag = args.includes("--all");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const dryRun = args.includes("--dry-run");
  const ids = idsArg ? idsArg.slice("--ids=".length).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : null;
  return { ids, allFlag, limit, dryRun };
}

export async function researchProduct(client: Anthropic, product: Product): Promise<ResearchResult> {
  const identity = `Brand: ${product.brand}\nProduct name: ${product.name}\nSize: ${product.size}\nConcentration: ${product.concentration || "unknown"}\nUPC/barcode: ${product.barcode || "none provided"}`;

  const system = `You research fragrance facts for a live-selling perfume resale business. You will be given the exact brand, product name, size, and concentration of ONE specific bottle currently in stock, plus its UPC when available.

Research rules — follow exactly:
1. Identify the EXACT fragrance variant (this specific flanker AND concentration AND size) using the brand, product name, size, concentration, and UPC given. Different flankers or concentrations of the same base name are DIFFERENT fragrances — never substitute a sibling variant (e.g. do not answer for the EDP if you were given the EDT, do not answer for a different flanker in the same line).
2. Prefer the official brand or product page as your source. Use another reputable fragrance reference source only if the official source doesn't give you enough to work with.
3. Do NOT guess. If you cannot confidently identify this exact variant, or the sources you find disagree or are unclear about it, say so — do not fabricate plausible-sounding notes.
4. Keep everything short — this is read at a glance by a host mid-livestream, not a paragraph.

Once you are done researching (or have concluded you cannot confidently identify this exact variant), respond with your final answer as a single JSON object wrapped EXACTLY between the literal markers <<<JSON_START>>> and <<<JSON_END>>> and nothing else between those markers — no markdown code fence, no trailing commentary inside the markers. Use straight double quotes for all JSON strings, and escape any double quote or backslash that appears inside a string value. The object must have exactly this shape:
{"identified": true or false, "keyNotes": array of 3 to 5 short note strings (e.g. "Bergamot") or empty array, "scentProfile": array of 2 to 3 short descriptor strings (e.g. "Fresh") or empty array, "quickSellingLine": one short sentence (a single string) or empty string, "sourceName": the name of the source you used (e.g. "Official Bond No. 9 product page") or empty string, "sourceUrl": the exact URL of that source or empty string, "sourceType": "official" if your source was the brand's own site, or "fallback" if it was another reputable fragrance reference site — empty string if identified is false, "reason": if identified is false, one short sentence on why; otherwise empty string}
If identified is false, keyNotes/scentProfile/quickSellingLine/sourceName/sourceUrl/sourceType must all be empty. You may write brief reasoning text before the markers, but the <<<JSON_START>>>...<<<JSON_END>>> block itself must contain nothing but the JSON object.`;

  let messages: Anthropic.MessageParam[] = [{ role: "user", content: `Research this exact fragrance:\n\n${identity}` }];
  let response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    system,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
    messages,
  });

  // Server-tool turns can pause on a long research chain — resume once,
  // per the documented pattern, rather than silently truncating.
  let resumes = 0;
  while (response.stop_reason === "pause_turn" && resumes < 2) {
    messages = [...messages, { role: "assistant", content: response.content }];
    response = await client.messages.create({ model: MODEL, max_tokens: 4096, thinking: { type: "adaptive" }, system, tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }], messages });
    resumes++;
  }

  if (response.stop_reason === "refusal") {
    return { identified: false, keyNotes: [], scentProfile: [], quickSellingLine: "", sourceName: "", sourceUrl: "", sourceType: "", reason: "Research request was declined." };
  }

  const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text);
  const finalText = textBlocks.join("\n").trim();

  try {
    const start = finalText.indexOf("<<<JSON_START>>>");
    const end = finalText.indexOf("<<<JSON_END>>>");
    const jsonText = start !== -1 && end !== -1 && end > start ? finalText.slice(start + "<<<JSON_START>>>".length, end).trim() : (finalText.match(/\{[\s\S]*\}/)?.[0] ?? null);
    if (!jsonText) throw new Error("No JSON object found between the expected markers in the model's final response.");
    const parsed = JSON.parse(jsonText);
    if (typeof parsed.identified !== "boolean") throw new Error("Missing/invalid 'identified' field.");
    return {
      identified: parsed.identified,
      keyNotes: Array.isArray(parsed.keyNotes) ? parsed.keyNotes.filter((n: unknown) => typeof n === "string").slice(0, 5) : [],
      scentProfile: Array.isArray(parsed.scentProfile) ? parsed.scentProfile.filter((n: unknown) => typeof n === "string").slice(0, 3) : [],
      quickSellingLine: typeof parsed.quickSellingLine === "string" ? parsed.quickSellingLine : "",
      sourceName: typeof parsed.sourceName === "string" ? parsed.sourceName : "",
      sourceUrl: typeof parsed.sourceUrl === "string" ? parsed.sourceUrl : "",
      sourceType: parsed.sourceType === "official" || parsed.sourceType === "fallback" ? parsed.sourceType : "",
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch (err) {
    if (process.env.DEBUG_RAW_RESPONSE) console.log("--- RAW FINAL TEXT (parse failure) ---\n" + finalText + "\n--- END RAW ---");
    return { identified: false, keyNotes: [], scentProfile: [], quickSellingLine: "", sourceName: "", sourceUrl: "", sourceType: "", reason: `Could not parse a structured answer from the research response: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function main() {
  const { ids, allFlag, limit, dryRun } = parseArgs();
  if (!ids && !allFlag) {
    console.error('STOP: refusing to run unscoped. Pass --ids=<id1>,<id2>,... for a specific set, or --all --limit=<N> (N <= ' + MAX_UNSCOPED_LIMIT + ') to process the next N eligible products.');
    process.exit(1);
  }
  if (allFlag && (!limit || limit <= 0 || limit > MAX_UNSCOPED_LIMIT)) {
    console.error(`STOP: --all requires --limit=<N> with 0 < N <= ${MAX_UNSCOPED_LIMIT}. Refusing to process the full catalog in one run.`);
    process.exit(1);
  }

  const client = new Anthropic();
  const products = await getProducts();

  let targets: Product[];
  if (ids) {
    targets = ids.map((id) => products.find((p) => p.id === id)).filter((p): p is Product => Boolean(p));
    const missing = ids.filter((id) => !products.some((p) => p.id === id));
    if (missing.length) console.log(`Note: ${missing.length} id(s) not found and skipped: ${missing.join(", ")}`);
  } else {
    targets = products.filter(needsSellingNotesResearch).slice(0, limit!);
  }

  console.log(`${dryRun ? "[DRY RUN] " : ""}Processing ${targets.length} product(s).\n`);

  for (const product of targets) {
    const before = { ...product };
    console.log(`=== ${product.brand} ${product.name} (${product.id}) ===`);
    console.log(`Size: ${product.size} | Concentration: ${product.concentration} | UPC: ${product.barcode} | Inventory: ${product.inventory}`);

    const result = await researchProduct(client, product);
    console.log(`Identified: ${result.identified}`);
    if (result.identified) {
      console.log(`Key Notes: ${result.keyNotes.join(" · ")}`);
      console.log(`Scent Profile: ${result.scentProfile.join(" · ")}`);
      console.log(`Quick Line: ${result.quickSellingLine}`);
      console.log(`Source: ${result.sourceName} (${result.sourceUrl})`);
    } else {
      console.log(`Reason left blank: ${result.reason}`);
    }

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

    if (dryRun) {
      console.log("[DRY RUN] Would write:", JSON.stringify(patch));
    } else {
      const updated = await updateProduct(product.id, patch);
      if (!updated) {
        console.log("WRITE FAILED — product not found at write time.");
      } else {
        // Prove nothing outside the 7 new selling-reference fields changed.
        const sellingFields = new Set(["sellingKeyNotes", "sellingScentProfile", "sellingQuickLine", "sellingNotesSourceName", "sellingNotesSourceUrl", "sellingNotesResearchedAt", "sellingNotesStatus"]);
        const changedOtherFields = (Object.keys(updated) as (keyof Product)[]).filter(
          (k) => !sellingFields.has(k) && JSON.stringify(updated[k]) !== JSON.stringify(before[k])
        );
        console.log(`Written. Fields other than the 7 selling-reference fields that changed: ${changedOtherFields.length === 0 ? "NONE" : changedOtherFields.join(", ")}`);
        console.log(`  inventory before/after: ${before.inventory} / ${updated.inventory}`);
        console.log(`  cost before/after: ${before.cost} / ${updated.cost}`);
        console.log(`  lootPrice before/after: ${before.lootPrice} / ${updated.lootPrice}`);
        console.log(`  retailPrice before/after: ${before.retailPrice} / ${updated.retailPrice}`);
      }
    }
    console.log("");
  }

  console.log("Done. This script never imports intake-db.ts, sales-analytics.ts, pricing-db.ts, or pricing-process.ts — structurally incapable of touching POs, lots, sales records, or Pricing/Ordering data regardless of what it researched.");
}
// Only auto-run when invoked directly (`npx tsx scripts/enrich-fragrance-selling-notes.ts ...`)
// — guarded so scripts/run-bulk-selling-notes-enrichment.ts can import
// researchProduct from this file without triggering a second, unscoped
// main() run of its own.
if (require.main === module) {
  main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
