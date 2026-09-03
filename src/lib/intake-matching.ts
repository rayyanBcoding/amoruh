import type { Product } from "./types";
import type { ExtractedLineItem, MatchCandidate, MatchedLineItem } from "./intake-types";

// ---------------------------------------------------------------------
// Product matching for Inventory Intake Mode.
//
// Order of precedence, per line: exact UPC -> exact SKU -> fuzzy
// brand+name+size+concentration. Nothing here ever auto-assigns a match —
// callers decide what confidence needs a human click (see FUZZY_THRESHOLD)
// vs. what's shown as unmatched outright.
// ---------------------------------------------------------------------

const FUZZY_THRESHOLD = 0.55;

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Dice coefficient over character bigrams — cheap, dependency-free, and
 *  tolerant of word-order/spacing differences between an invoice's product
 *  description and our own catalog naming. */
function bigramSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      out.set(bg, (out.get(bg) ?? 0) + 1);
    }
    return out;
  };

  const ba = bigrams(na);
  const bb = bigrams(nb);
  let overlap = 0;
  for (const [bg, count] of ba) {
    const other = bb.get(bg);
    if (other) overlap += Math.min(count, other);
  }
  const total = [...ba.values()].reduce((s, n) => s + n, 0) + [...bb.values()].reduce((s, n) => s + n, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

function productSignature(p: { brand: string; name: string; size: string; concentration: string }): string {
  return `${p.brand} ${p.name} ${p.size} ${p.concentration}`;
}

function fuzzyBest(line: ExtractedLineItem, products: Product[]): MatchCandidate | null {
  const signature = productSignature(line);
  let best: { product: Product; score: number } | null = null;

  for (const p of products) {
    const score = bigramSimilarity(signature, productSignature(p));
    if (!best || score > best.score) best = { product: p, score };
  }

  if (!best || best.score < FUZZY_THRESHOLD) return null;
  return {
    productId: best.product.id,
    sku: best.product.sku,
    brand: best.product.brand,
    name: best.product.name,
    size: best.product.size,
    confidence: Math.round(best.score * 100) / 100,
  };
}

export function matchLineItem(line: ExtractedLineItem, products: Product[]): MatchedLineItem {
  const upc = line.upc.trim().toUpperCase();
  if (upc) {
    const exact = products.find((p) => p.barcode.toUpperCase() === upc);
    if (exact) {
      return {
        ...line,
        matchType: "upc",
        candidate: {
          productId: exact.id,
          sku: exact.sku,
          brand: exact.brand,
          name: exact.name,
          size: exact.size,
          confidence: 1,
        },
      };
    }
  }

  // Some invoices reference our own SKU instead of the manufacturer UPC.
  const skuGuess = normalize(line.rawDescription);
  const skuMatch = products.find((p) => skuGuess.includes(normalize(p.sku)) && p.sku.length >= 4);
  if (skuMatch) {
    return {
      ...line,
      matchType: "sku",
      candidate: {
        productId: skuMatch.id,
        sku: skuMatch.sku,
        brand: skuMatch.brand,
        name: skuMatch.name,
        size: skuMatch.size,
        confidence: 1,
      },
    };
  }

  const fuzzy = fuzzyBest(line, products);
  if (fuzzy) {
    return { ...line, matchType: "fuzzy", candidate: fuzzy };
  }

  return { ...line, matchType: "unmatched", candidate: null };
}

export function matchLineItems(lines: ExtractedLineItem[], products: Product[]): MatchedLineItem[] {
  return lines.map((line) => matchLineItem(line, products));
}
