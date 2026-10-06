// ---------------------------------------------------------------------
// Supplier-description normalization layer.
//
// Separates IDENTITY-bearing wording from supplier/listing NOISE before a
// description is tokenized for matching. Applied identically to a
// supplier row and to an existing Master Product's own text, so both
// sides of every comparison are cleaned the same way. Nothing here ever
// rewrites what is STORED on a supplier offer — the original supplier
// description stays on the offer for traceability; only the text used to
// derive identity (and the display name of a newly created Master
// Product) is cleaned.
//
// Principles (each one was driven by the Master Product grouping audit):
//  - Strip only wording that is KNOWN to be listing noise. Unknown text,
//    including unknown bracketed text, stays identity-bearing.
//  - Bare "NEW" is only noise when decorated (*NEW*, (NEW), [NEW PACK]) or
//    trailing after a size/concentration — an undecorated "NEW" can be
//    part of a name ("Kate Spade New York").
//  - Gender and condition are NOT noise: they are extracted as their own
//    attributes so they can gate a match (M vs W never merges; an
//    UNBOX / NO CAP / BOX DAMAGE listing is its own comparison bucket).
//  - Supplier-specific annotations are stripped only for the supplier
//    that is verified to use them.
// ---------------------------------------------------------------------

export type RowCondition = "standard" | "unboxed" | "no_cap" | "damaged_box";
export type Gender = "m" | "w" | "u";

export interface SupplierNormalizationProfile {
  /** Annotations stripped ONLY for this supplier. */
  stripAnnotations: RegExp[];
}

/** Keyed by supplier id. A profile is added only after the annotation has
 *  been verified, from that supplier's own data, to be a pure listing
 *  note and never part of fragrance identity.
 *
 *  Perfume Center of America: "(LI FREE)" appears on 1,660 of its 4,313
 *  offers, on no other supplier, always as a parenthesized note, and the
 *  same fragrance is listed both with and without it. "(LI)" is the same
 *  note on gift-set components. */
export const SUPPLIER_NORMALIZATION_PROFILES: Record<string, SupplierNormalizationProfile> = {
  sup_1789721338561_2kztd8: {
    stripAnnotations: [/\(\s*li\s*free\s*\)/gi, /\(\s*li\s*\)/gi],
  },
};

// ---- known listing noise -------------------------------------------------

// "NEW" family: only counts as noise when decorated on BOTH sides.
const NEW_FAMILY = "new(?:\\s*(?:launch|size|box|look|packaging|pack|formula|release|version))?|newpack";
const DECORATED_NEW_RE = new RegExp(`(?:[*\\[(]\\s*)+(?:${NEW_FAMILY})(?:\\s*[*\\])])+`, "gi");

// Long, unambiguous availability/channel notes: safe even undecorated.
const AVAILABILITY_PHRASES = [
  "approved?\\s+(?:retailers?|customers?)\\s+only",
  "authori[sz]ed\\s+(?:retailers?|customers?)\\s+only",
  "no\\s+online\\s+sellers?",
  "not\\s+for\\s+online\\s+(?:stores?|sellers?|sales)",
  "ltd\\.?\\s*qty",
  "limited\\s+(?:qty|quantity)",
  "only\\s+usa",
  "usa\\s+only",
  "us\\s+only",
].join("|");
const AVAILABILITY_RE = new RegExp(`(?:[*\\[(]\\s*)*(?:${AVAILABILITY_PHRASES})(?:\\s*[*\\])])*`, "gi");

// Trailing bare NEW, only after a size or concentration has already been
// stated ("... EDP SPR NEW"), never mid-name.
const TRAILING_NEW_RE = /\s+new\s*$/i;
const HAS_SIZE_OR_CONCENTRATION_RE = /\b(?:edp|edt|edc|cologne|parfum|extrait)\b|\d\s*(?:ml|oz)\b/i;

// Trailing 2-letter market code that follows a size/concentration/format
// word ("... EDP 100 ml IT"). Position-aware on purpose: a 2-letter word
// anywhere else (or after anything else) is left alone.
const COUNTRY_CODES = "fr|it|es|uk|us|ae|de|se|tr|ca|ch|za|sa|ksa";
const TRAILING_COUNTRY_RE = new RegExp(
  `(?:\\b(?:ml|oz|edp|edt|edc|cologne|parfum|extrait|tester|spr|sp|spray)|\\d(?:ml|oz))\\s*[.,]?\\s+(?:${COUNTRY_CODES})\\s*$`,
  "i"
);
const TRAILING_COUNTRY_CAPTURE_RE = new RegExp(`\\s+(?:${COUNTRY_CODES})\\s*$`, "i");

// ---- condition ----------------------------------------------------------

const DAMAGED_BOX_RE = /\(?\s*box\s*damage(?:d)?(?:\s*only)?\s*\)?|\bdamaged\s+box\b/gi;
const NO_CAP_RE = /\(?\s*\b(?:no|w\/?o|without)\s*cap\b(?:\s*[,&]\s*(?:no\s*)?box\b)?\s*\)?/gi;
const UNBOX_RE = /\(?\s*\bun\s*-?\s*box(?:ed)?\b\s*\)?|\bno\s*box\b|\bnobox\b/gi;
// Existing tester semantics ("w/o box" == tester) are preserved: the text
// is treated as unboxed AND flagged as a tester marker.
const WITHOUT_BOX_RE = /\b(?:w\/?o|without)\s*box\b/gi;
// "(CAP,BOX)" / "(CAP&BOX)" / "W/CAP": the normal, complete state — not a
// downgrade, just removed so it doesn't leak into name tokens.
const CAP_BOX_STANDARD_RE = /\(\s*(?:w\/\s*)?cap\s*(?:,|&|and)\s*box\s*\)|\bw\/\s*cap\b/gi;

// ---- gender -------------------------------------------------------------

const GENDER_MARKER_RE = /[(\[]\s*(m|w|u|men|women|unisex|man|woman|mens|womens|men's|women's)\s*[*.]?\s*[)\]]/gi;
const FOR_MEN_RE = /\bfor\s+men\b/gi;
const FOR_WOMEN_RE = /\bfor\s+women\b/gi;

function genderOf(marker: string): Gender {
  const g = marker.toLowerCase();
  if (g === "m" || g === "men" || g === "man" || g === "mens" || g === "men's") return "m";
  if (g === "w" || g === "women" || g === "woman" || g === "womens" || g === "women's") return "w";
  return "u";
}

// ---- tester marker ------------------------------------------------------

// Perfume Center's "(T)" tester marker.
const TESTER_MARKER_RE = /\(\s*t\s*\)/gi;

export interface NormalizedListing {
  /** Cleaned text, ready for tokenization/size/concentration parsing. */
  text: string;
  /** Explicit gender marker, if the listing states one. */
  gender: Gender | null;
  condition: RowCondition;
  /** True when a "(T)" tester marker was present (and removed). */
  testerMarker: boolean;
  /** Noise phrases that were removed, for audit/diagnostics. */
  removed: string[];
}

function has(re: RegExp, t: string): boolean {
  re.lastIndex = 0;
  const r = re.test(t);
  re.lastIndex = 0;
  return r;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\s+([,;)\]])/g, "$1").trim();
}

/** Removes known listing noise only — keeps gender/condition/tester
 *  markers in place. This is also what a newly created Master Product's
 *  display name is derived from, so the name stays a faithful, readable
 *  description while the identity re-derived from it matches the row. */
export function stripListingNoise(text: string, supplierId?: string | null): { text: string; removed: string[] } {
  const removed: string[] = [];
  let t = text;
  const profile = supplierId ? SUPPLIER_NORMALIZATION_PROFILES[supplierId] : undefined;
  if (profile) {
    for (const re of profile.stripAnnotations) {
      t = t.replace(re, (m) => {
        removed.push(m.trim());
        return " ";
      });
    }
  }
  // Repeat: "* APPROVED RETAILERS ONLY * ***NEW***" collapses over passes.
  for (let pass = 0; pass < 3; pass++) {
    const before = t;
    t = t.replace(DECORATED_NEW_RE, (m) => {
      removed.push(m.trim());
      return " ";
    });
    t = t.replace(AVAILABILITY_RE, (m) => {
      if (m.trim()) removed.push(m.trim());
      return " ";
    });
    if (t === before) break;
  }
  if (has(HAS_SIZE_OR_CONCENTRATION_RE, t) && has(TRAILING_NEW_RE, t)) {
    t = t.replace(TRAILING_NEW_RE, () => {
      removed.push("new");
      return " ";
    });
  }
  // Orphaned asterisks left behind by decoration ("***", "* *") — but never
  // the multiplication sign in a component list ("5*0.33 Oz").
  t = t.replace(/(\d)\s*\*\s*(?=\d|\.\d)/g, "$1\u0001").replace(/\*+/g, " ").replace(/\u0001/g, "*");
  return { text: collapse(t), removed };
}

/** Display name for a newly created Master Product: listing noise removed,
 *  everything identity-bearing (gender, condition, tester, set contents,
 *  unknown brackets) preserved verbatim. Never used to alter the supplier
 *  offer's own stored description. */
export function cleanDisplayName(raw: string, supplierId?: string | null): string {
  const cleaned = stripListingNoise(raw, supplierId).text;
  return cleaned.length > 0 ? cleaned : raw.trim();
}

/** Full normalization used for identity derivation. */
export function normalizeListingText(raw: string, supplierId?: string | null): NormalizedListing {
  const stripped = stripListingNoise(raw, supplierId);
  let t = stripped.text;
  const removed = [...stripped.removed];

  // Condition — worst applicable marker wins. Markers are removed from the
  // text so they don't leak into name tokens (the condition attribute
  // carries them instead).
  let condition: RowCondition = "standard";
  if (has(DAMAGED_BOX_RE, t)) condition = "damaged_box";
  t = t.replace(DAMAGED_BOX_RE, " ");
  if (condition === "standard" && has(NO_CAP_RE, t)) condition = "no_cap";
  t = t.replace(NO_CAP_RE, " ");
  const withoutBox = has(WITHOUT_BOX_RE, t);
  if (condition === "standard" && (withoutBox || has(UNBOX_RE, t))) condition = "unboxed";
  t = t.replace(WITHOUT_BOX_RE, " ").replace(UNBOX_RE, " ");
  t = t.replace(CAP_BOX_STANDARD_RE, " ");

  // Tester marker ("(T)", or the existing "w/o box" tester convention).
  const testerMarker = has(TESTER_MARKER_RE, t) || withoutBox;
  t = t.replace(TESTER_MARKER_RE, " ");

  // Gender: explicit bracketed markers only.
  const found = new Set<Gender>();
  t = t.replace(GENDER_MARKER_RE, (_m, g: string) => {
    found.add(genderOf(g));
    return " ";
  });
  GENDER_MARKER_RE.lastIndex = 0;
  const gender: Gender | null = found.size === 1 ? [...found][0] : null;
  // "FOR MEN"/"FOR WOMEN" is redundant (and removed) only when an explicit
  // marker already states the same gender; otherwise it stays as ordinary
  // identity-bearing text (it can be part of a product name).
  if (gender === "m") t = t.replace(FOR_MEN_RE, " ");
  if (gender === "w") t = t.replace(FOR_WOMEN_RE, " ");

  // Trailing market code.
  if (has(TRAILING_COUNTRY_RE, t)) {
    t = t.replace(TRAILING_COUNTRY_CAPTURE_RE, " ");
  }

  return { text: collapse(t), gender, condition, testerMarker, removed };
}

// ---- size ---------------------------------------------------------------

// Standard manufacturer sizes. 3.3 oz, 3.4 oz and 100 ml are the same
// marketed bottle; the snap is deliberately tight (+/-3%) so genuinely
// different sizes (e.g. 1.6 oz vs 1.7 oz/50 ml) are never merged.
const STANDARD_SIZES_ML = [5, 7.5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 80, 90, 100, 120, 125, 150, 175, 200, 250, 300];

export function snapNominalSize(ml: number): number {
  for (const s of STANDARD_SIZES_ML) {
    if (Math.abs(ml - s) / s <= 0.03) return s;
  }
  return ml;
}

// ---- review reasons -----------------------------------------------------

/** Plain-English explanation of why a row didn't match confidently, shown
 *  in the review workflow so an operator can see WHY at a glance. */
export const REVIEW_REASON_LABELS: Record<string, string> = {
  barcode_tester_vs_retail: "Same barcode, but one listing is a tester and the other is retail.",
  barcode_gift_set_vs_single: "Same barcode, but one listing is a gift set and the other a single bottle.",
  barcode_refill_vs_regular: "Same barcode, but one listing is a refill and the other a regular bottle.",
  barcode_condition_differs: "Same barcode, but the box/cap condition differs (e.g. tester with cap vs tester with no cap). Kept apart so they never compete for Best Price.",
  barcode_gender_conflict: "Same barcode, but the listings state different genders (M vs W).",
  barcode_size_form_or_concentration_differs: "Same barcode, but the size, product form, or concentration (e.g. EDP vs Extrait) differs.",
  barcode_text_mismatch: "Same barcode, but the product names look unrelated.",
  regional_barcode_variant: "Same apparent fragrance as an existing Master Product, but with a different barcode (regional/market variant). Not linked automatically.",
  multiple_exact_targets: "More than one existing Master Product matches this name exactly, so it can't be linked without guessing.",
  gender_unstated_or_unisex: "Matches an existing Master Product, but this listing doesn't state a gender (or says unisex) while the product does.",
  condition_variant_of_existing: "Matches an existing Master Product except for box/cap condition. Not auto-created as a new product; review whether it's the same fragrance in a different condition.",
  concentration_not_stated: "The listing doesn't state a concentration (EDT/EDP/etc.), so the exact product can't be determined.",
  fuzzy_ambiguity: "Similar to existing products but not an exact identity match.",
  exact_identity_ambiguous: "Matches existing products but the exact one can't be determined.",
};

export function describeReviewReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (REVIEW_REASON_LABELS[reason]) return REVIEW_REASON_LABELS[reason];
  if (reason.startsWith("not_eligible_for_auto_create:")) return `Can't be turned into a new product automatically (${reason.slice("not_eligible_for_auto_create:".length).trim()}).`;
  return reason;
}
