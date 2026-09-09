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
  /** Every content token (stopwords/size/unit stripped, but NOT
   *  brand-stripped) — used to check brand containment when this side
   *  has no explicit brand column of its own (see brandsMatch). */
  allTokens: string[];
  /** Brand-stripped, for cross-side text similarity (supporting
   *  evidence only). */
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

const SIZE_TOKEN_PATTERN = /(\d+(?:\.\d+)?)\s*(ml|oz)/;
// "100ml" survives tokenize() as one token (caught by SIZE_TOKEN_PATTERN
// below), but "100 ML" (a space before the unit) splits into two
// separate tokens — "100" (caught by the bare-digit check) and a stray
// "ml" that neither check removes on its own. Without UNIT_WORDS, that
// stray unit token asymmetrically survives only on the spaced side,
// which is precisely the "100ml" vs "100 ML" case this matcher exists
// to treat as equivalent — so it's filtered explicitly here too.
const UNIT_WORDS = new Set(["ml", "oz", "fl"]);

function contentTokens(fullText: string): string[] {
  return [
    ...new Set(
      tokenize(fullText).filter(
        (t) => !STOPWORDS.has(t) && !SIZE_TOKEN_PATTERN.test(t) && !UNIT_WORDS.has(t) && !/^\d+$/.test(t)
      )
    ),
  ].sort();
}

/** Extracts structured attributes from a combined brand+name/description
 *  string — used identically for a supplier row and a catalog product so
 *  the two sides are always compared on the same basis. `brand` is
 *  passed separately WHEN KNOWN (e.g. a supplier sheet with its own
 *  Brand column, or Product.brand) — many real supplier sheets have only
 *  one free-text description column with no separate brand field at
 *  all, so `brand` may legitimately be "". brandsMatch() below handles
 *  that case by checking brand-word containment against `allTokens`
 *  rather than requiring both sides to have an isolated brand string. */
export function extractAttributes(fullText: string, brand: string): StructuredAttributes {
  const brandToken = normalize(brand);
  const sizeMl = parseSizeMl(fullText);
  const concentration = parseConcentration(fullText);
  const isTester = TESTER_PATTERN.test(normalize(fullText));
  const isGiftSet = GIFT_SET_PATTERN.test(normalize(fullText));

  const allTokens = contentTokens(fullText);
  const brandWords = new Set(tokenize(brand));
  const coreNameTokens = allTokens.filter((t) => !brandWords.has(t));

  return { brandToken, allTokens, coreNameTokens, sizeMl, concentration, isTester, isGiftSet };
}

/** Deliberately does NOT fold `p.concentration` into the text used for
 *  name/core-token comparison. Fixed directly: a supplier row almost
 *  never spells out "Eau de Parfum," so appending the catalog product's
 *  own concentration FIELD to its comparison text created an extra
 *  token ("parfum") the row could never match — unfairly discounting a
 *  genuine match's text score without actually helping distinguish real
 *  flankers. A flanker word that's genuinely part of a product's
 *  marketed identity (e.g. "Aventus Cologne," "Le Male Le Parfum") lives
 *  in `p.name` already, not in the separate concentration field, so it's
 *  still fully present in the comparison text and still counted. The
 *  concentration BUCKET itself (used only by the hard gate, never for
 *  text comparison) is still resolved from name+concentration combined,
 *  so a flanker word appearing only in `p.name` is still recognized. */
export function extractProductAttributes(p: Pick<Product, "brand" | "name" | "size" | "concentration">): StructuredAttributes {
  const base = extractAttributes(`${p.brand} ${p.name} ${p.size}`, p.brand);
  const concentration = parseConcentration(`${p.name} ${p.concentration}`);
  return { ...base, concentration };
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

/** Text similarity — token-set (word-order independent, fixes "Aventus
 *  by Creed 100ml" vs "Creed Aventus 100 ML") combined with bigram
 *  (catches in-token misspellings token-set alone would miss, e.g.
 *  "Aventis" vs "Aventus").
 *
 *  Two real bugs here, both confirmed directly and both fixed:
 *
 *  1. Bigram over the FULL raw strings (brand, stray words like "by,"
 *     size, country/gender codes and all) can't tell "one side has an
 *     entire extra distinguishing WORD" from "these are basically the
 *     same string" — "Creed Aventus" vs "Creed Aventus Cologne" scored
 *     0.68 on raw-string bigram alone (one string is just a prefix of
 *     the other) even though token-set correctly saw a 50% mismatch
 *     (the missing "cologne" — the very flanker word that makes these
 *     different products). Conversely, raw-string bigram can also score
 *     too LOW for a genuine typo match ("Aventis by Creed 100 ML" vs
 *     "Creed Aventus") because unrelated surrounding words dilute it.
 *     Fixed by comparing bigram over the same BRAND-STRIPPED core-name
 *     tokens used for token-set similarity, not the full raw strings —
 *     isolating the actual name comparison from brand/size/stray-word
 *     noise on both sides of the bug.
 *  2. Each side's own `coreNameTokens` only ever strips ITS OWN brand
 *     field. When one side has no separate brand column (`brandToken`
 *     is ""), its brand word never gets stripped from its own tokens,
 *     while the other side (which does have an explicit brand) strips
 *     it — an asymmetric comparison that unfairly drags a genuine
 *     match's score down. Fixed by resolving ONE shared brand (whichever
 *     side has one) and stripping it fresh from BOTH sides' full token
 *     lists here, so the comparison is always apples-to-apples
 *     regardless of which side happened to have a Brand column. */
function textScore(a: StructuredAttributes, b: StructuredAttributes): number {
  const knownBrand = a.brandToken || b.brandToken;
  const brandWords = knownBrand ? new Set(knownBrand.split(" ").filter(Boolean)) : new Set<string>();
  const coreA = brandWords.size > 0 ? a.allTokens.filter((t) => !brandWords.has(t)) : a.coreNameTokens;
  const coreB = brandWords.size > 0 ? b.allTokens.filter((t) => !brandWords.has(t)) : b.coreNameTokens;

  const tokenScore = tokenSetSimilarity(coreA, coreB);
  const bigram = bigramSimilarity(coreA.join(" "), coreB.join(" "));
  const maxLen = Math.max(coreA.length, coreB.length, 1);
  const lengthAgreement = 1 - Math.abs(coreA.length - coreB.length) / maxLen;
  return Math.max(tokenScore, bigram * lengthAgreement);
}

/** Both sides with an explicit brand string: compare directly (with typo
 *  tolerance). If exactly one side has no brand column at all (common
 *  for supplier sheets — a single free-text description, no separate
 *  Brand field), fall back to checking whether the KNOWN side's brand
 *  appears, as whole word(s), within the OTHER side's full text — this
 *  is what lets "Aventus by Creed 100ml" (no brand column) still
 *  confirm against a catalog product whose brand is "Creed". If
 *  NEITHER side has a brand at all, there's nothing to confirm against. */
function brandsMatch(a: StructuredAttributes, b: StructuredAttributes): boolean {
  if (a.brandToken && b.brandToken) {
    return a.brandToken === b.brandToken || bigramSimilarity(a.brandToken, b.brandToken) >= 0.8;
  }
  const known = a.brandToken ? a : b;
  const unknown = a.brandToken ? b : a;
  if (!known.brandToken) return false;
  const brandWords = known.brandToken.split(" ").filter(Boolean);
  if (brandWords.length === 0) return false;
  // Full word containment — e.g. "Creed" inside "aventus by creed 100ml".
  if (brandWords.every((w) => unknown.allTokens.includes(w))) return true;
  // Common multi-word-brand abbreviation/initialism — e.g. "JPG" for
  // "Jean Paul Gaultier", "YSL" for "Yves Saint Laurent". Required
  // explicitly by spec §2 ("common abbreviations"); without this, a
  // supplier row that only ever writes the initialism can never
  // structurally confirm against a catalog brand stored under its full
  // name, which would otherwise wrongly read as an alias conflict.
  if (brandWords.length > 1) {
    const initials = brandWords.map((w) => w[0]).join("");
    if (unknown.allTokens.includes(initials)) return true;
  }
  return false;
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
  if (!brandsMatch(a, b)) {
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

/** Confidence composition.
 *
 *  Revised after direct testing against a real 6,305-row supplier file
 *  matched against a real catalog found concrete false positives: the
 *  original design gave brand+size(+concentration) agreement such a
 *  high baseline (0.87, or 0.95 with matching concentration) that text
 *  similarity could barely move the result — "GUESS GIRL EDT 100ml"
 *  auto-matched to "Guess Seductive Noir Body Lotion" (text similarity
 *  0.22) purely because brand and size lined up. Worse, "PACO RABANNE 1
 *  MILLION LUCKY EDT 100ml" auto-matched "1 Million Travel Set" at 0.98
 *  confidence — both sides say EDT 100ml, but that only confirms
 *  format, not which fragrance. Concentration match is strong NEGATIVE
 *  evidence (a mismatch is disqualifying, via the hard gate above) but
 *  weak POSITIVE evidence — many different products from one brand
 *  share a format. Brand and size confirm you're looking at plausibly
 *  the same PRODUCT LINE; text similarity is what actually confirms
 *  it's the same PRODUCT, and is now the primary driver once the hard
 *  gates (which can still only push toward zero, never up) pass.
 *
 *  Calibrated directly against real cases: "Aventus by Creed 100ml" /
 *  "Creed Aventus 100ml EDP" (text 0.67, no concentration stated on the
 *  row) clears the 0.85 auto-match threshold; the four real false
 *  positives above (text 0.22–0.58) all now land below it — most below
 *  0.55, straight to New Candidate rather than even Match Review. */
export function scoreStructuredMatch(a: StructuredAttributes, b: StructuredAttributes): StructuredMatchScore {
  const gate = checkHardGates(a, b);
  if (!gate.passes) return { confidence: 0, gate };

  if (!gate.sizeBothParsed) {
    // Size didn't even parse on one side (malformed row) — can't fully
    // confirm structurally; lean on text but cap below auto-match so
    // this always lands in Match Review rather than trusting text alone.
    return { confidence: Math.min(0.7, textScore(a, b)), gate };
  }

  const text = textScore(a, b);
  return { confidence: Math.min(1, 0.05 + text * 1.3), gate };
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
    const score = scoreStructuredMatch(rowAttrs, productAttrs);
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
