import type { Product } from "./types";
import type { OfferMatchType, PricingReferenceProduct, ReviewStatus, SupplierAlias, SupplierOfferCurrent } from "./pricing-types";
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
// "refill"/"recharge" only — deliberately NOT matching "refillable" (a
// normal bottle sold as refillable is still a standalone bottle sale,
// not the standalone-refill-pack SKU this exists to distinguish). Word
// boundary after "refill" already excludes "refillable" (no boundary
// between "refill" and the following "able").
const REFILL_PATTERN = /\brefill\b|\brecharge\b/;

// Non-fragrance product forms — a hard gate everywhere this is compared
// against anything else (see checkHardGates). "fragrance" is the
// default for every row/product that doesn't match one of these, which
// is exactly what keeps the gate a no-op for the overwhelming majority
// of genuine fragrance-vs-fragrance comparisons while still closing the
// real production incident this was built to fix: "Guess Seductive
// Noir Body Lotion" has no recognized CONCENTRATION at all (so that gate
// stood down) and previously matched several different EDT fragrances
// on brand+size+text alone.
export type ProductForm =
  | "fragrance"
  | "body_lotion"
  | "deodorant"
  | "aftershave"
  | "body_spray"
  | "shower_gel"
  | "soap"
  | "candle";

const PRODUCT_FORM_PATTERNS: [RegExp, ProductForm][] = [
  [/\bbody\s*lotion\b/, "body_lotion"],
  [/\bafter\s*shave\b/, "aftershave"],
  [/\bbody\s*spray\b/, "body_spray"],
  [/\bshower\s*gel\b/, "shower_gel"],
  [/\bdeodorant\b/, "deodorant"],
  [/\bsoap\b/, "soap"],
  [/\bcandle\b/, "candle"],
];

export function classifyProductForm(text: string): ProductForm {
  const n = normalize(text);
  for (const [pattern, form] of PRODUCT_FORM_PATTERNS) {
    if (pattern.test(n)) return form;
  }
  return "fragrance";
}

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
  /** Standalone refill/recharge pack vs. a normal bottle — a materially
   *  different sellable SKU even at the same brand/size/concentration. */
  isRefill: boolean;
  /** "fragrance" (the default) or an explicit non-fragrance form. */
  productForm: ProductForm;
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
  const isRefill = REFILL_PATTERN.test(normalize(fullText));
  const productForm = classifyProductForm(fullText);

  const allTokens = contentTokens(fullText);
  const brandWords = new Set(tokenize(brand));
  const coreNameTokens = allTokens.filter((t) => !brandWords.has(t));

  return { brandToken, allTokens, coreNameTokens, sizeMl, concentration, isTester, isGiftSet, isRefill, productForm };
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

/** Same idea as extractProductAttributes, for a Master/Reference
 *  Product — but PREFERS the already-stored structured fields
 *  (authoritative, resolved once at creation/track time) over
 *  re-parsing text, which is what extractProductAttributes has to do
 *  since real Product has no such stored fields. Only brandToken/
 *  allTokens/coreNameTokens (needed for text-similarity comparison) are
 *  derived from combined text. */
export function extractReferenceProductAttributes(rp: PricingReferenceProduct): StructuredAttributes {
  const base = extractAttributes(`${rp.brand} ${rp.name} ${rp.description}`, rp.brand);
  return {
    ...base,
    sizeMl: rp.sizeMl,
    concentration: rp.concentration,
    isTester: rp.isTester,
    isGiftSet: rp.isGiftSet,
    isRefill: rp.isRefill,
    productForm: rp.productForm as ProductForm,
  };
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
  if (a.isRefill !== b.isRefill) return { passes: false, concentrationBothRecognized: false, sizeBothParsed: false };
  // "fragrance" is the default productForm for both sides in the
  // overwhelming majority of real comparisons, so plain equality is
  // exactly the right gate: it's a no-op for fragrance-vs-fragrance,
  // and fails the instant either side is an explicit, differing
  // non-fragrance form (e.g. body lotion vs. EDT) — no separate
  // "recognized vs. default" branching needed.
  if (a.productForm !== b.productForm) return { passes: false, concentrationBothRecognized: false, sizeBothParsed: false };

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
// Master Product candidate pool — combines real Products and Master/
// Reference Products into one identity space for matching, with a
// linked pair (PricingReferenceProduct.productId set) always
// represented ONCE, via its real Product entry, never as two separate
// candidates that could form an artificial sibling pair with each
// other or appear as two separate search results.
// ---------------------------------------------------------------------

export interface MasterCandidate {
  /** Real Product id, if this candidate is (or is linked to) one. */
  productId: string | null;
  /** Master/Reference Product id, if this candidate has one —
   *  independent of whether it's also physically carried. A candidate
   *  always has at least one of these two set. */
  referenceProductId: string | null;
  attrs: StructuredAttributes;
  upc: string;
  ean: string;
}

export function buildMasterCandidatePool(products: Product[], referenceProducts: PricingReferenceProduct[]): MasterCandidate[] {
  const linkedReferenceByProductId = new Map(referenceProducts.filter((rp) => rp.productId).map((rp) => [rp.productId as string, rp]));

  const pool: MasterCandidate[] = products.map((p) => ({
    productId: p.id,
    referenceProductId: linkedReferenceByProductId.get(p.id)?.id ?? null,
    attrs: extractProductAttributes(p),
    upc: p.barcode,
    ean: p.barcode,
  }));

  for (const rp of referenceProducts) {
    if (rp.productId) continue; // already represented above via its linked real Product
    pool.push({
      productId: null,
      referenceProductId: rp.id,
      attrs: extractReferenceProductAttributes(rp),
      upc: rp.upc,
      ean: rp.ean,
    });
  }

  return pool;
}

export interface MasterMatchResult {
  outcome: "auto_match" | "needs_review" | "no_match";
  winner: MasterCandidate | null;
  /** Every competing identity, for display — populated for "needs_review"
   *  (both the ordinary single-best-guess case and the genuine
   *  sibling-competition case), empty otherwise. */
  competingCandidates: MasterCandidate[];
  confidence: number | null;
}

// A near-tie between the top two scores is treated the same as a
// genuine structural ambiguity — text alone shouldn't quietly pick a
// winner when the row's own wording doesn't clearly favor one flanker/
// edition over another (e.g. "Man" scoring close to both "Man" and
// "Man Ice"). This is judged only among candidates that already
// survive every hard gate below — it never overrides a real variant
// conflict, and it never fires when there's only one survivor.
const SIBLING_SCORE_MARGIN = 0.1;

/** The row-relative ambiguity rule (replaces a fixed brand/size/
 *  concentration bucket key, which breaks on "DIOR SAUVAGE 100ML": the
 *  three real Sauvage EDT/EDP/Parfum candidates would land in three
 *  different buckets and the matcher could still auto-pick one).
 *  Ambiguity is judged relative to what the incoming ROW itself
 *  specifies, not the candidates' own labels — see pricing-matching's
 *  header comment / the Phase 1 plan for the full reasoning. */
export function matchAgainstMasterCandidates(rowAttrs: StructuredAttributes, pool: MasterCandidate[]): MasterMatchResult {
  // Reuse scoreStructuredMatch (not a hand-rolled gate + raw textScore)
  // for every candidate: checkHardGates already only enforces
  // concentration equality when BOTH sides have a recognized value —
  // rowAttrs.concentration === null already means the gate is silent
  // for every candidate regardless of ITS OWN concentration, which is
  // exactly the row-relative behavior this needs, with no separate gate
  // logic to duplicate or drift out of sync with checkHardGates. Scoring
  // this way also preserves the tuned confidence formula (0.05 + text
  // * 1.3, calibrated against real production false positives) instead
  // of comparing raw text similarity against thresholds tuned for that
  // formula.
  const allScored = pool.map((candidate) => ({ candidate, result: scoreStructuredMatch(rowAttrs, candidate.attrs) }));
  const survivors = allScored.filter((s) => s.result.gate.passes);

  if (survivors.length === 0) return { outcome: "no_match", winner: null, competingCandidates: [], confidence: null };

  const scored = survivors
    .map((s) => ({ candidate: s.candidate, score: s.result.confidence }))
    .sort((a, b) => b.score - a.score);

  // The row never stated a concentration, and the survivors themselves
  // disagree on it — always needs_review, listing every survivor. A
  // text score, however high (even identical across all of them, as in
  // the Sauvage example), never breaks this tie: the row never supplied
  // the information needed to.
  if (rowAttrs.concentration === null) {
    const distinctConcentrations = new Set(survivors.map((s) => s.candidate.attrs.concentration ?? "unstated"));
    if (distinctConcentrations.size > 1) {
      return {
        outcome: "needs_review",
        winner: null,
        competingCandidates: survivors.map((s) => s.candidate),
        confidence: scored[0]?.score ?? null,
      };
    }
  }

  const classifyTop = (top: { candidate: MasterCandidate; score: number }): MasterMatchResult => {
    if (top.score >= AUTO_MATCH_THRESHOLD) {
      return { outcome: "auto_match", winner: top.candidate, competingCandidates: [], confidence: top.score };
    }
    if (top.score >= REVIEW_THRESHOLD) {
      return { outcome: "needs_review", winner: null, competingCandidates: [top.candidate], confidence: top.score };
    }
    return { outcome: "no_match", winner: null, competingCandidates: [], confidence: top.score };
  };

  if (scored.length === 1) return classifyTop(scored[0]);

  // 2+ survivors even after concentration is accounted for — a core-
  // name/flanker-level ambiguity. A clear leader still auto-matches
  // normally; a near-tie is needs_review with every near-tied candidate
  // shown, same "don't let text alone decide when the row is genuinely
  // ambiguous" principle applied to the flanker axis.
  const [top, second] = scored;
  if (top.score - second.score < SIBLING_SCORE_MARGIN) {
    return {
      outcome: "needs_review",
      winner: null,
      competingCandidates: survivors.map((s) => s.candidate),
      confidence: top.score,
    };
  }
  return classifyTop(top);
}

// Pure format ABBREVIATIONS only — never a marketed flanker name on
// their own (unlike "Parfum"/"Cologne"/"Elixir"/"Le Parfum," which
// genuinely distinguish one product LINE from another and must stay
// part of the comparable core name — see extractProductAttributes's own
// comment on "Aventus Cologne"). Verified directly against real
// production reference-product names (all abbreviated: "EDT"/"EDP"),
// so this covers this business's actual supplier data; a fully spelled-
// out "Eau de Parfum" (rare in practice here) is a deliberately accepted
// remaining gap rather than risking a strip broad enough to also eat a
// genuine flanker word.
const SIGNATURE_ABBREVIATION_TOKENS = new Set(["edp", "edt", "edc"]);

/** Global Master Product identity signature — every structured
 *  dimension that determines whether two items are actually the same
 *  sellable SKU, canonically normalized so equivalent supplier wording
 *  produces the same signature. Deliberately excludes supplier-specific
 *  description text and supplier SKU (this is a global identity, not a
 *  per-supplier one). Used as the fallback exact-match pointer for
 *  auto-creation dedup when no UPC/EAN is available — see
 *  pricing-db.ts's get-or-create-by-identity primitive.
 *
 *  The core-name component strips bare EDP/EDT/EDC abbreviation tokens
 *  before joining — attrs.concentration already normalizes those to one
 *  bucket, so leaving the literal abbreviation word in (as
 *  coreNameTokens correctly does for TEXT similarity, on purpose) would
 *  otherwise make "Sauvage EDP" and "Sauvage EDT" — or "EDP" vs a fully
 *  spelled-out "Eau de Parfum," where a stray "parfum" token survives —
 *  diverge here even though they resolve to the same concentration
 *  field. Never touches the shared coreNameTokens/textScore path used
 *  by the calibrated fuzzy matcher elsewhere — this is signature-only. */
export function computeIdentitySignature(attrs: StructuredAttributes): string {
  const signatureCoreName = attrs.coreNameTokens.filter((t) => !SIGNATURE_ABBREVIATION_TOKENS.has(t)).join(" ");
  return [
    attrs.brandToken,
    signatureCoreName,
    attrs.sizeMl ?? "",
    attrs.concentration ?? "",
    attrs.productForm,
    attrs.isTester ? "tester" : "retail",
    attrs.isGiftSet ? "giftset" : "standalone",
    attrs.isRefill ? "refill" : "bottle",
  ].join("|");
}

export interface AutoCreateEligibility {
  eligible: boolean;
  reason?: string;
}

/** Structural completeness check for auto-creating a new Master
 *  Product — deliberately NOT a loose "2 of N fields present" rule. A
 *  row auto-creates only when its parsed identity is a genuinely
 *  complete, exact sellable SKU; anything less (most notably: a
 *  fragrance whose concentration isn't stated, e.g. "DIOR SAUVAGE
 *  100ML") stays new_candidate/needs_review instead of manufacturing an
 *  incomplete permanent identity. */
export function checkAutoCreateEligibility(attrs: StructuredAttributes): AutoCreateEligibility {
  if (!attrs.brandToken) return { eligible: false, reason: "brand not recognized" };
  if (attrs.coreNameTokens.length === 0) return { eligible: false, reason: "no fragrance/product-line name beyond brand" };
  if (attrs.sizeMl === null) return { eligible: false, reason: "size not parsed" };
  if (attrs.concentration === null && attrs.productForm === "fragrance") {
    return { eligible: false, reason: "concentration ambiguous (EDT/EDP/Parfum/etc. not stated) for a fragrance item" };
  }
  return { eligible: true };
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
  /** Set alongside productId when the resolved identity is (or is
   *  linked to) a Master/Reference Product, OR alone when the row
   *  resolves to a Master Product AMORUH has never physically carried. */
  referenceProductId: string | null;
  matchType: OfferMatchType;
  matchConfidence: number | null;
  reviewStatus: ReviewStatus;
  /** Best-guess candidate to show for a one-click confirm — set for
   *  needs_review/new_candidate/alias_conflict/barcode_conflict, never
   *  auto-applied. Mutually exclusive with candidateReferenceProductId —
   *  a suggestion is a real Product or a reference-only Master Product,
   *  never both. */
  candidateProductId: string | null;
  candidateReferenceProductId: string | null;
  /** Set only for a genuine sibling-competition needs_review row (see
   *  matchAgainstMasterCandidates) — every competing identity, for
   *  display. */
  competingCandidates?: { productId: string | null; referenceProductId: string | null }[];
}

function rawTextOf(row: Pick<MatchRowInput, "brand" | "description">): string {
  return `${row.brand} ${row.description}`;
}

/** referenceProducts defaults to [] so every existing caller keeps
 *  compiling and behaving identically (real-catalog-only matching)
 *  until it's explicitly passed the current Master Product list. */
export function matchSupplierRow(
  row: MatchRowInput,
  products: Product[],
  aliases: SupplierAlias[],
  referenceProducts: PricingReferenceProduct[] = []
): MatchRowResult {
  const productById = new Map(products.map((p) => [p.id, p]));
  const rowAttrs = extractAttributes(rawTextOf(row), row.brand);
  const rowText = rawTextOf(row);

  // 1. Learned alias — memory, not proof. Aliases only ever point at a
  // real Product (see SupplierAlias's type). Revalidate against the
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
          referenceProductId: null,
          matchType: "alias",
          matchConfidence: 1,
          reviewStatus: "auto_matched",
          candidateProductId: alias.productId,
          candidateReferenceProductId: null,
        };
      }
      return {
        productId: null,
        referenceProductId: null,
        matchType: "unmatched",
        matchConfidence: null,
        reviewStatus: "alias_conflict",
        candidateProductId: alias.productId,
        candidateReferenceProductId: null,
      };
    }
  }

  // 2. Exact UPC/EAN — strongest identifier when available, checked
  // against real Products first (unchanged), then Master/Reference
  // Products. A barcode match paired with wildly different text is
  // flagged instead of trusted blindly either way (spec §3: "supplier
  // spreadsheets can contain errors").
  const code = (row.upc || row.ean).trim().toUpperCase();
  if (code) {
    const exactProduct = products.find((p) => p.barcode.toUpperCase() === code);
    if (exactProduct) {
      const text = bigramSimilarity(rowText, `${exactProduct.brand} ${exactProduct.name}`);
      if (text < BARCODE_CONFLICT_TEXT_FLOOR) {
        return {
          productId: null,
          referenceProductId: null,
          matchType: "unmatched",
          matchConfidence: null,
          reviewStatus: "barcode_conflict",
          candidateProductId: exactProduct.id,
          candidateReferenceProductId: null,
        };
      }
      return {
        productId: exactProduct.id,
        referenceProductId: null,
        matchType: row.upc ? "upc" : "ean",
        matchConfidence: 0.98,
        reviewStatus: "auto_matched",
        candidateProductId: exactProduct.id,
        candidateReferenceProductId: null,
      };
    }

    const exactRef = referenceProducts.find(
      (rp) => (rp.upc && rp.upc.toUpperCase() === code) || (rp.ean && rp.ean.toUpperCase() === code)
    );
    if (exactRef) {
      // Already linked to a real Product — resolve via that Product,
      // per the pool-dedup rule (a linked pair is one identity, never
      // two), but still record the Master identity alongside it.
      const linkedProduct = exactRef.productId ? productById.get(exactRef.productId) : undefined;
      const resolvedProductId = linkedProduct?.id ?? null;
      const labelBrand = linkedProduct?.brand ?? exactRef.brand;
      const labelName = linkedProduct?.name ?? exactRef.name;
      const text = bigramSimilarity(rowText, `${labelBrand} ${labelName}`);
      if (text < BARCODE_CONFLICT_TEXT_FLOOR) {
        return {
          productId: null,
          referenceProductId: null,
          matchType: "unmatched",
          matchConfidence: null,
          reviewStatus: "barcode_conflict",
          candidateProductId: resolvedProductId,
          candidateReferenceProductId: resolvedProductId ? null : exactRef.id,
        };
      }
      return {
        productId: resolvedProductId,
        referenceProductId: exactRef.id,
        matchType: row.upc ? "upc" : "ean",
        matchConfidence: 0.98,
        reviewStatus: "auto_matched",
        candidateProductId: resolvedProductId,
        candidateReferenceProductId: resolvedProductId ? null : exactRef.id,
      };
    }
  }

  // 3. Gated structured match against the combined, deduped Master
  // Product candidate pool — ambiguity judged relative to what the row
  // itself specifies (see matchAgainstMasterCandidates).
  const pool = buildMasterCandidatePool(products, referenceProducts);
  const result = matchAgainstMasterCandidates(rowAttrs, pool);

  if (result.outcome === "auto_match" && result.winner) {
    return {
      productId: result.winner.productId,
      referenceProductId: result.winner.referenceProductId,
      matchType: "structured",
      matchConfidence: result.confidence !== null ? Math.round(result.confidence * 100) / 100 : null,
      reviewStatus: "auto_matched",
      candidateProductId: result.winner.productId,
      candidateReferenceProductId: result.winner.productId ? null : result.winner.referenceProductId,
    };
  }

  if (result.outcome === "needs_review") {
    const top = result.competingCandidates[0] ?? null;
    return {
      productId: null,
      referenceProductId: null,
      matchType: "unmatched",
      matchConfidence: result.confidence !== null ? Math.round(result.confidence * 100) / 100 : null,
      reviewStatus: "needs_review",
      candidateProductId: top?.productId ?? null,
      candidateReferenceProductId: top?.productId ? null : (top?.referenceProductId ?? null),
      competingCandidates:
        result.competingCandidates.length > 1
          ? result.competingCandidates.map((c) => ({ productId: c.productId, referenceProductId: c.referenceProductId }))
          : undefined,
    };
  }

  return {
    productId: null,
    referenceProductId: null,
    matchType: "unmatched",
    matchConfidence: result.confidence !== null ? Math.round(result.confidence * 100) / 100 : null,
    reviewStatus: "new_candidate",
    candidateProductId: null,
    candidateReferenceProductId: null,
  };
}

// ---------------------------------------------------------------------
// Import safety — plan's "Import safety" section. A read-only dry-match
// pass over PARSED rows (never over raw upload rows) against the
// current catalog/aliases/Master Products, extending the Preview step
// rather than a third UI step. Never writes anything — the caller
// (parse-preview route) already never writes; this is purely additive
// classification of what processing WOULD do.
// ---------------------------------------------------------------------

export interface MatchPreviewSummary {
  totalRows: number;
  matchedProduct: number;
  matchedReferenceProduct: number;
  proposedNewMasterProducts: number;
  requiresReview: number;
  /** A genuine "nothing matched, and not even structurally complete
   *  enough to auto-create" row — e.g. no brand recognized at all, or a
   *  fragrance whose concentration is unstated. Distinct from
   *  requiresReview (which DOES have a specific competing candidate or
   *  conflict to show); this is the honest "we can't say anything about
   *  this row yet" bucket. */
  unsupported: number;
}

export function computeMatchPreview(
  rows: { supplierSku: string; description: string; brand: string; upc: string; ean: string }[],
  products: Product[],
  aliases: SupplierAlias[],
  referenceProducts: PricingReferenceProduct[]
): MatchPreviewSummary {
  let matchedProduct = 0;
  let matchedReferenceProduct = 0;
  let proposedNewMasterProducts = 0;
  let requiresReview = 0;
  let unsupported = 0;

  // A local, in-memory-only "would auto-create" pool — mirrors the real
  // upload's own mutable in-import list (plan §4/§5b) so a genuine
  // repeat of the same physical item within this SAME preview is only
  // counted once, not twice. Never written to Redis; discarded with this
  // function call.
  const previewPool = [...referenceProducts];
  let previewIdSeq = 0;

  for (const row of rows) {
    const offerKey = deriveOfferKey(row.supplierSku, row.description);
    const match = matchSupplierRow({ offerKey, ...row }, products, aliases, previewPool);

    if (match.reviewStatus === "auto_matched") {
      if (match.productId) matchedProduct++;
      else matchedReferenceProduct++;
      continue;
    }
    if (match.reviewStatus === "new_candidate") {
      const rowAttrs = extractAttributes(`${row.brand} ${row.description}`, row.brand);
      const eligibility = checkAutoCreateEligibility(rowAttrs);
      if (!eligibility.eligible) {
        unsupported++;
        continue;
      }
      proposedNewMasterProducts++;
      previewPool.push({
        id: `preview_${previewIdSeq++}`,
        brand: row.brand,
        name: row.description,
        description: row.description,
        sizeMl: rowAttrs.sizeMl,
        concentration: rowAttrs.concentration,
        isTester: rowAttrs.isTester,
        isGiftSet: rowAttrs.isGiftSet,
        isRefill: rowAttrs.isRefill,
        productForm: rowAttrs.productForm,
        upc: row.upc,
        ean: row.ean,
        productId: null,
        createdAt: "",
        createdBy: "preview",
        creationMethod: "auto_import",
        createdFromSupplierId: null,
        createdFromUploadId: null,
        createdFromOfferKey: null,
      });
      continue;
    }
    // needs_review, alias_conflict, barcode_conflict
    requiresReview++;
  }

  return { totalRows: rows.length, matchedProduct, matchedReferenceProduct, proposedNewMasterProducts, requiresReview, unsupported };
}

// ---------------------------------------------------------------------
// Supplier-item identity fallback — reconnects a row to its OWN prior
// supplier-item identity across uploads when the row's offerKey changed
// (e.g. the supplier reformatted their SKU column). Deliberately NOT an
// offerKey migration: the direct offerKey lookup in pricing-process.ts
// is tried first and is the normal, fast path (confirmed stable across
// 9 real uploads — see the Match Review audit); this fallback only ever
// runs when that direct lookup misses. It reconnects supplier-ITEM
// identity to a prior SupplierOfferCurrent (a different concern from
// matchSupplierRow's row-to-real-catalog matching above, which is
// unchanged and still runs regardless).
//
// Priority, per spec: exact UPC/EAN (revalidated against structured
// attributes, same hard gates used everywhere else) first, then a
// strict composite identity (brand + size + concentration + tester/
// gift-set bucket, via the SAME checkHardGates, plus a text-similarity
// bar stricter than the normal 0.85 real-catalog auto-match threshold —
// this is conservative supplier-item reconciliation, not catalog
// matching). Returns null — never guesses — when zero or more than one
// candidate qualifies; a genuinely new item, or an ambiguous one, is
// always safer left new than silently merged into the wrong history.
// Hard gates guarantee a different size/concentration/tester/gift-set
// variant can never reconnect here.
const IDENTITY_FALLBACK_TEXT_THRESHOLD = 0.92;

export function findPreviousBySupplierItemIdentity(
  row: { upc: string; ean: string; brand: string; description: string },
  previousOffers: Record<string, SupplierOfferCurrent>
): SupplierOfferCurrent | null {
  const rowAttrs = extractAttributes(rawTextOf(row), row.brand);
  const candidates = Object.values(previousOffers);

  const rowCode = (row.upc || row.ean || "").trim().toUpperCase();
  if (rowCode) {
    const byCode = candidates.filter((o) => {
      const code = (o.upc || o.ean || "").trim().toUpperCase();
      return code === rowCode;
    });
    if (byCode.length === 1) {
      const candidateAttrs = extractAttributes(rawTextOf(byCode[0]), byCode[0].brand);
      if (checkHardGates(rowAttrs, candidateAttrs).passes) return byCode[0];
    }
    // More than one previous offer shares this code, or the one match
    // fails the hard gate — fall through to the composite check rather
    // than trusting a contested or contradicted barcode.
  }

  let best: { offer: SupplierOfferCurrent; score: number } | null = null;
  let qualifyingCount = 0;
  for (const o of candidates) {
    const candidateAttrs = extractAttributes(rawTextOf(o), o.brand);
    const gate = checkHardGates(rowAttrs, candidateAttrs);
    if (!gate.passes || !gate.sizeBothParsed || !gate.concentrationBothRecognized) continue;
    const score = textScore(rowAttrs, candidateAttrs);
    if (score >= IDENTITY_FALLBACK_TEXT_THRESHOLD) {
      qualifyingCount++;
      if (!best || score > best.score) best = { offer: o, score };
    }
  }
  return qualifyingCount === 1 && best ? best.offer : null;
}

// ---------------------------------------------------------------------
// Duplicate-supplier-name detection — used only at the point a NEW
// supplier is about to be created from free text (Pricing/Ordering's
// Suppliers page), to warn an operator before "JIzan" and "Jizan
// Perfumes llc" happen again as two unrelated supplier identities with
// zero shared history. Deliberately NOT quickTextSimilarity: that scores
// full raw strings, which empirically gets this exact job backwards — it
// scored the real "JIzan"/"Jizan Perfumes llc" duplicate at 0.38 (missed)
// while scoring two genuinely unrelated companies that happen to share a
// generic "Trading Inc" suffix at 0.79 (false positive). Stripping
// generic corporate-suffix words first, then checking whether one name's
// remaining core tokens are contained in the other's (or, failing that,
// a stricter token-set bar on the stripped tokens), gets both cases
// right — verified directly against real supplier names from this
// engagement, not assumed.
const CORP_SUFFIX_WORDS = new Set(["llc", "inc", "ltd", "co", "company", "corp", "corporation", "trading"]);

function coreSupplierTokens(name: string): string[] {
  return tokenize(name).filter((t) => !CORP_SUFFIX_WORDS.has(t));
}

export function isPossibleDuplicateSupplierName(a: string, b: string): boolean {
  const tokensA = coreSupplierTokens(a);
  const tokensB = coreSupplierTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const [shorter, longer] = tokensA.length <= tokensB.length ? [setA, setB] : [setB, setA];
  const contained = [...shorter].every((t) => longer.has(t) || [...longer].some((l) => bigramSimilarity(t, l) >= 0.85));
  if (contained) return true;
  return tokenSetSimilarity(tokensA, tokensB) >= 0.6;
}
