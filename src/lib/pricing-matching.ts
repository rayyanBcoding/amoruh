import type { Product } from "./types";
import type { OfferMatchType, ReviewStatus, SupplierAlias } from "./pricing-types";
import { normalize, bigramSimilarity } from "./intake-matching";

// ---------------------------------------------------------------------
// Supplier price-sheet matching — Pricing/Ordering's own matcher.
//
// Deliberately NOT a reuse of intake-matching.ts's single-threshold
// bigram-fuzzy approach: that was built for invoice line items, where
// ambiguity is rare. A supplier price sheet has hundreds/thousands of
// loosely, inconsistently formatted rows, and needs:
//   - structured attributes (size/concentration/tester/gift-set) treated
//     as hard gates that can only force a non-match, never inflate one
//   - word-order-independent text comparison (token-set), not bigram
//     alone, which under-scores "Aventus by Creed" vs "Creed Aventus"
//   - a persistent per-supplier alias memory, checked first, but
//     revalidated against current attributes every time (a stale alias
//     is memory, not proof)
//
// bigramSimilarity/normalize ARE reused from intake-matching.ts as one
// input signal (catching in-token misspellings a token-set comparison
// alone would miss), not the whole algorithm.
// ---------------------------------------------------------------------

const AUTO_MATCH_THRESHOLD = 0.85;
const REVIEW_THRESHOLD = 0.55;
const BARCODE_CONFLICT_TEXT_FLOOR = 0.25;
const ML_PER_OZ = 29.5735;
const STOPWORDS = new Set(["by", "eau", "de", "the", "and", "for", "in", "a", "an", "of"]);

// Longest-match-wins, checked in this order so "eau de parfum" doesn't
// get shadowed by a bare "parfum" match, and "le parfum" (a specific
// JPG-style flanker phrase) is distinguished from generic "parfum".
// Note: this is really "formulation/flanker qualifier," broader than
// strict ISO concentration — that's intentional, since a flanker like
// "Elixir" or "Le Parfum" needs to hard-gate exactly like EDP vs EDT
// does (spec's own JPG Elixir vs. JPG Le Parfum example).
const CONCENTRATION_PATTERNS: [RegExp, string][] = [
  [/\beau\s*de\s*parfum\b|\bedp\b/, "edp"],
  [/\beau\s*de\s*toilette\b|\bedt\b/, "edt"],
  [/\beau\s*de\s*cologne\b|\bedc\b/, "cologne"],
  [/\bextrait\s*de\s*parfum\b|\bpure\s*parfum\b|\bextrait\b/, "extrait"],
  [/\belixir\b/, "elixir"],
  [/\ble\s*parfum\b/, "le_parfum"],
  [/\bcologne\b/, "cologne"],
  [/\bparfum\b/, "parfum"],
];

const TESTER_PATTERN = /\btester\b|\btstr\b|\bw\/?o\s*box\b|\bwithout\s*box\b/;
const GIFT_SET_PATTERN = /\bgift\s*set\b|\bset\s*of\b|\bcoffret\b|\b\d\s*pc\s*set\b|\bkit\b/;

export interface StructuredAttributes {
  brandToken: string;
  coreNameTokens: string[];
  sizeMl: number | null;
  concentration: string | null;
  isTester: boolean;
  isGiftSet: boolean;
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .replace(/[^a-z0-9\s.]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function parseSizeMl(text: string): number | null {
  const ml = text.match(/(\d+(?:\.\d+)?)\s*ml\b/i);
  if (ml) return parseFloat(ml[1]);
  const oz = text.match(/(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?oz\b/i);
  if (oz) return Math.round(parseFloat(oz[1]) * ML_PER_OZ * 10) / 10;
  return null;
}

export function parseConcentration(text: string): string | null {
  const n = normalize(text);
  for (const [pattern, bucket] of CONCENTRATION_PATTERNS) {
    if (pattern.test(n)) return bucket;
  }
  return null;
}

/** Extracts structured attributes from a combined brand+name/description
 *  string — used identically for a supplier row and a catalog product so
 *  the two sides are always compared on the same basis. `brand` is
 *  passed separately when known (supplier rows / Product.brand) so it
 *  can be stripped from the core-name token set for text comparison. */
export function extractAttributes(fullText: string, brand: string): StructuredAttributes {
  const brandToken = normalize(brand);
  const sizeMl = parseSizeMl(fullText);
  const concentration = parseConcentration(fullText);
  const isTester = TESTER_PATTERN.test(normalize(fullText));
  const isGiftSet = GIFT_SET_PATTERN.test(normalize(fullText));

  const brandTokens = new Set(tokenize(brand));
  const sizeToken = /(\d+(?:\.\d+)?)\s*(ml|oz)/;
  // "100ml" survives tokenize() as one token (caught by sizeToken below),
  // but "100 ML" (a space before the unit) splits into two separate
  // tokens — "100" (caught by the bare-digit check) and a stray "ml"
  // that neither check removes on its own. Without UNIT_WORDS, that
  // stray unit token asymmetrically survives only on the spaced side,
  // which is precisely the "100ml" vs "100 ML" case this matcher exists
  // to treat as equivalent — so it's filtered explicitly here too.
  const UNIT_WORDS = new Set(["ml", "oz", "fl"]);
  const coreNameTokens = [
    ...new Set(
      tokenize(fullText).filter(
        (t) => !brandTokens.has(t) && !STOPWORDS.has(t) && !sizeToken.test(t) && !UNIT_WORDS.has(t) && !/^\d+$/.test(t)
      )
    ),
  ].sort();

  return { brandToken, coreNameTokens, sizeMl, concentration, isTester, isGiftSet };
}

export function extractProductAttributes(p: Pick<Product, "brand" | "name" | "size" | "concentration">): StructuredAttributes {
  return extractAttributes(`${p.brand} ${p.name} ${p.size} ${p.concentration}`, p.brand);
}

export function tokenSetSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Text similarity used only as SUPPORTING evidence beneath structured
 *  attributes — token-set (word-order independent, fixes "Aventus by
 *  Creed 100ml" vs "Creed Aventus 100 ML") combined with bigram (catches
 *  in-token misspellings token-set alone would miss), max of the two. */
function textScore(a: StructuredAttributes, b: StructuredAttributes, rawA: string, rawB: string): number {
  const tokenScore = tokenSetSimilarity(a.coreNameTokens, b.coreNameTokens);
  const bigram = bigramSimilarity(rawA, rawB);
  return Math.max(tokenScore, bigram);
}

function brandsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return bigramSimilarity(a, b) >= 0.8;
}

function sizesMatch(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  return diff <= 3 || diff / Math.max(a, b) <= 0.04;
}

export interface HardGateResult {
  passes: boolean;
  /** Only meaningful when passes=true: whether BOTH sides had a
   *  recognized concentration (affects confidence composition). */
  concentrationBothRecognized: boolean;
  /** Only meaningful when passes=true: whether size parsed on both
   *  sides. */
  sizeBothParsed: boolean;
}

/** Hard gates — can only ever push toward "not a match," never raise a
 *  score. Brand mismatch, size outside tolerance, a RECOGNIZED
 *  concentration mismatch, or any tester/gift-set disagreement all fail
 *  this regardless of how similar the surrounding text is. */
export function checkHardGates(a: StructuredAttributes, b: StructuredAttributes): HardGateResult {
  if (!brandsMatch(a.brandToken, b.brandToken)) {
    return { passes: false, concentrationBothRecognized: false, sizeBothParsed: false };
  }
  if (a.isTester !== b.isTester) return { passes: false, concentrationBothRecognized: false, sizeBothParsed: false };
  if (a.isGiftSet !== b.isGiftSet) return { passes: false, concentrationBothRecognized: false, sizeBothParsed: false };

  const sizeBothParsed = a.sizeMl !== null && b.sizeMl !== null;
  if (sizeBothParsed && !sizesMatch(a.sizeMl as number, b.sizeMl as number)) {
    return { passes: false, concentrationBothRecognized: false, sizeBothParsed };
  }

  const concentrationBothRecognized = a.concentration !== null && b.concentration !== null;
  if (concentrationBothRecognized && a.concentration !== b.concentration) {
    return { passes: false, concentrationBothRecognized, sizeBothParsed };
  }

  return { passes: true, concentrationBothRecognized, sizeBothParsed };
}

export interface StructuredMatchScore {
  confidence: number;
  gate: HardGateResult;
}

/** Confidence composition — structured agreement is the primary driver;
 *  text score fills gaps rather than leading, and can never override a
 *  failed hard gate (checkHardGates must be called first). */
export function scoreStructuredMatch(a: StructuredAttributes, b: StructuredAttributes, rawA: string, rawB: string): StructuredMatchScore {
  const gate = checkHardGates(a, b);
  if (!gate.passes) return { confidence: 0, gate };

  const text = textScore(a, b, rawA, rawB);

  if (gate.sizeBothParsed && gate.concentrationBothRecognized) {
    // Brand + size + concentration all cleanly agree — every structured
    // signal available confirms this is the same product; text can only
    // nudge it toward 1.0.
    return { confidence: Math.min(1, 0.95 + text * 0.05), gate };
  }
  if (gate.sizeBothParsed) {
    // Brand + size agree; concentration wasn't recognized on one or both
    // sides (the hard gate above already ruled out an actual conflict —
    // this is "not mentioned," not "different"). This is the common
    // real-world case (spec's own "Creed Aventus 100ml," no EDP/EDT
    // marker at all) and should still score high on structured grounds
    // alone — text confirms rather than having to carry the score, so a
    // pair like "Aventus by Creed 100ml" / "Creed Aventus 100 ML" lands
    // comfortably above the auto-match threshold even before text is
    // added, exactly as the word-order-independent design intends.
    return { confidence: Math.min(1, 0.87 + text * 0.13), gate };
  }
  // Size didn't even parse on one side (malformed row) — can't fully
  // confirm structurally; lean on text but cap below auto-match so this
  // always lands in Match Review rather than trusting text alone.
  return { confidence: Math.min(0.7, text), gate };
}

// ---------------------------------------------------------------------
// Row-level matching — alias (with conflict revalidation) -> UPC/EAN
// (with barcode-conflict revalidation) -> gated structured match.
// ---------------------------------------------------------------------

/** Free-text search similarity — same word-order-independent + bigram
 *  combination as row matching, but over plain strings (a search query
 *  rarely carries size/concentration, so full structured extraction
 *  isn't useful here). Used by the global Pricing/Ordering search. */
export function quickTextSimilarity(a: string, b: string): number {
  return Math.max(tokenSetSimilarity(tokenize(a), tokenize(b)), bigramSimilarity(a, b));
}

export function deriveOfferKey(supplierSku: string, description: string): string {
  const sku = supplierSku.trim();
  if (sku) return `sku:${normalize(sku)}`;
  return `desc:${normalize(description)}`;
}

export interface MatchRowInput {
  offerKey: string;
  supplierSku: string;
  description: string;
  brand: string;
  upc: string;
  ean: string;
}

export interface MatchRowResult {
  productId: string | null;
  matchType: OfferMatchType;
  matchConfidence: number | null;
  reviewStatus: ReviewStatus;
  /** Best-guess candidate to show for a one-click confirm — set for
   *  needs_review/new_candidate/alias_conflict/barcode_conflict, never
   *  auto-applied. */
  candidateProductId: string | null;
}

function rawTextOf(row: Pick<MatchRowInput, "brand" | "description">): string {
  return `${row.brand} ${row.description}`;
}

export function matchSupplierRow(row: MatchRowInput, products: Product[], aliases: SupplierAlias[]): MatchRowResult {
  const productById = new Map(products.map((p) => [p.id, p]));
  const rowAttrs = extractAttributes(rawTextOf(row), row.brand);
  const rowText = rawTextOf(row);

  // 1. Learned alias — memory, not proof. Revalidate against the
  // aliased product's CURRENT attributes/barcode before trusting it.
  const alias = aliases.find((a) => a.offerKey === row.offerKey);
  if (alias) {
    const aliasedProduct = productById.get(alias.productId);
    if (aliasedProduct) {
      const productAttrs = extractProductAttributes(aliasedProduct);
      const gate = checkHardGates(rowAttrs, productAttrs);
      const barcodeConflict =
        Boolean(row.upc || row.ean) &&
        Boolean(aliasedProduct.barcode) &&
        aliasedProduct.barcode.toUpperCase() !== row.upc.toUpperCase() &&
        aliasedProduct.barcode.toUpperCase() !== row.ean.toUpperCase();
      if (gate.passes && !barcodeConflict) {
        return {
          productId: alias.productId,
          matchType: "alias",
          matchConfidence: 1,
          reviewStatus: "auto_matched",
          candidateProductId: alias.productId,
        };
      }
      return {
        productId: null,
        matchType: "unmatched",
        matchConfidence: null,
        reviewStatus: "alias_conflict",
        candidateProductId: alias.productId,
      };
    }
  }

  // 2. Exact UPC/EAN — strongest identifier when available, but a
  // barcode match paired with wildly different text is flagged instead
  // of trusted blindly (spec §3: "supplier spreadsheets can contain errors").
  const code = (row.upc || row.ean).trim().toUpperCase();
  if (code) {
    const exact = products.find((p) => p.barcode.toUpperCase() === code);
    if (exact) {
      const text = bigramSimilarity(rowText, `${exact.brand} ${exact.name}`);
      if (text < BARCODE_CONFLICT_TEXT_FLOOR) {
        return {
          productId: null,
          matchType: "unmatched",
          matchConfidence: null,
          reviewStatus: "barcode_conflict",
          candidateProductId: exact.id,
        };
      }
      return {
        productId: exact.id,
        matchType: row.upc ? "upc" : "ean",
        matchConfidence: 0.98,
        reviewStatus: "auto_matched",
        candidateProductId: exact.id,
      };
    }
  }

  // 3-6. Gated structured match against every product — best candidate.
  let best: { product: Product; score: StructuredMatchScore } | null = null;
  for (const p of products) {
    const productAttrs = extractProductAttributes(p);
    const score = scoreStructuredMatch(rowAttrs, productAttrs, rowText, `${p.brand} ${p.name}`);
    if (score.confidence > 0 && (!best || score.confidence > best.score.confidence)) {
      best = { product: p, score };
    }
  }

  if (best && best.score.confidence >= AUTO_MATCH_THRESHOLD) {
    return {
      productId: best.product.id,
      matchType: "structured",
      matchConfidence: Math.round(best.score.confidence * 100) / 100,
      reviewStatus: "auto_matched",
      candidateProductId: best.product.id,
    };
  }
  if (best && best.score.confidence >= REVIEW_THRESHOLD) {
    return {
      productId: null,
      matchType: "unmatched",
      matchConfidence: Math.round(best.score.confidence * 100) / 100,
      reviewStatus: "needs_review",
      candidateProductId: best.product.id,
    };
  }

  return {
    productId: null,
    matchType: "unmatched",
    matchConfidence: best ? Math.round(best.score.confidence * 100) / 100 : null,
    reviewStatus: "new_candidate",
    candidateProductId: best?.product.id ?? null,
  };
}
