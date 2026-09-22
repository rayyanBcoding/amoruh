// Persistent regression tests for the two Miami/unsupported-merchandise
// fixes in pricing-matching.ts. No Redis access, no network — pure
// function tests. Run any time with:
//   npx tsx scripts/test-size-and-merchandise-rules.ts
import { parseSizeMl, isValidProductRow, isUnsupportedMerchandise, extractAttributes } from "../src/lib/pricing-matching";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- Size parsing: positive cases (real Miami Trading Zone shapes) ---
check(
  "Miami 3.4 before EXTRAIT DE PARFUM -> 100ml",
  parseSizeMl("FRENCH AVENUE AROMATIX SUN KISSED 3.4 EXTRAIT DE PARFUM U"),
  100
);
check("Miami 2.0 before EDP -> 60ml", parseSizeMl("ARMAF I WILL 2.0 EDP M REFILLABLE"), 60);
check("Miami 3.4 before EDP -> 100ml", parseSizeMl("OCEAN PACIFIC STORM 3.4 EDP M"), 100);
check("bare 1.7 before EDT -> 50ml", parseSizeMl("SOME BRAND FRAGRANCE 1.7 EDT"), 50);
check("bare 4.2 before PARFUM -> 125ml", parseSizeMl("SOME BRAND FRAGRANCE 4.2 PARFUM"), 125);
check("bare 1.0 before EDP -> 30ml", parseSizeMl("SOME BRAND FRAGRANCE 1.0 EDP"), 30);

// --- Size parsing: explicit units still work exactly as before (no regression) ---
check("explicit 100 ml unaffected", parseSizeMl("CHANEL BLEU DE CHANEL EDT 100 ml"), 100);
check("explicit 3.4 oz unaffected", parseSizeMl("SOME FRAGRANCE 3.4 Oz EDT"), 100);
check("gift-set component sizes still explicit-only", parseSizeMl("PACO 1 MILLION SET EDT 100 ml + EDT 10 ml TRAVEL SPRAY"), 100);

// --- Size parsing: negative cases (must NOT infer a size) ---
check("whole number before concentration is NOT inferred (no decimal point)", parseSizeMl("SOME BRAND FRAGRANCE 6 EDP"), null);
check("decimal outside plausible oz range is NOT inferred", parseSizeMl("SOME BRAND FRAGRANCE 15.5 EDP"), null);
check("bare decimal with no concentration nearby is NOT inferred", parseSizeMl("SOME BRAND ITEM 3.4 MODEL NUMBER STYLE"), null);
check("no size information anywhere", parseSizeMl("SOME BRAND FRAGRANCE EDP SPRAY"), null);

// --- Packaging equivalence: Miami's "3.4 EDP" and an explicit "100ml EDP" ---
// row must resolve to the IDENTICAL sizeMl so they can match as the same SKU.
const miamiAttrs = extractAttributes("XERJOFF CASAFUTURA 3.4 EDP L", "XERJOFF");
const explicitAttrs = extractAttributes("XERJOFF CASAFUTURA EDP 100 ML", "XERJOFF");
check("Miami-style and explicit-ml sizes normalize to the same value", miamiAttrs.sizeMl, explicitAttrs.sizeMl);
check("...and that value is 100", miamiAttrs.sizeMl, 100);

// --- Unsupported merchandise: positive cases (must be excluded) ---
check(
  "empty gift box excluded",
  isValidProductRow({ description: "CHRISTIAN DIOR HOLIDAY MEDIUM FOLDABLE GIFT BOX (EMPTY BOX)" }),
  false
);
check("bottle sleeve excluded", isValidProductRow({ description: "HUGO BOSS BOSS BLACK BOTTLE SLEEVE" }), false);
check("makeup pouch excluded", isValidProductRow({ description: "JIMMY CHOO (W) MAKEUP POUCH" }), false);
check("drawstring bag excluded", isValidProductRow({ description: "HOLLISTER HIM DRAWSTRING BAG" }), false);
check("paper bag excluded", isValidProductRow({ description: "MERCEDES BENZ AMG PAPER BAG" }), false);
check("display stand excluded", isValidProductRow({ description: "BURBERRY BRIT SMALL DISPLAY STAND" }), false);
check("empty automiser excluded", isValidProductRow({ description: "CALVIN KLEIN CK ONE REFILLABLE 8ML AUTOMISER (EMPTY)" }), false);

// --- Unsupported merchandise: negative cases (must NOT be excluded — real products) ---
check(
  "a real fragrance gift SET that mentions a box is NOT excluded (states a concentration)",
  isValidProductRow({ description: "CHANEL COCO GIFT SET EDP 100ML + BODY LOTION + GIFT BOX" }),
  true
);
check(
  "a real fragrance that happens to say 'cologne' is not excluded by the pattern",
  isValidProductRow({ description: "CALVIN KLEIN ETERNITY COLOGNE 100 ML" }),
  true
);
check("a plain fragrance row is unaffected", isValidProductRow({ description: "DIOR SAUVAGE EDT 100ML" }), true);
check(
  "isUnsupportedMerchandise direct check — false for a real product",
  isUnsupportedMerchandise("CHANEL COCO GIFT SET EDP 100ML + BODY LOTION + GIFT BOX"),
  false
);
check(
  "isUnsupportedMerchandise direct check — true for packaging-only",
  isUnsupportedMerchandise("CHRISTIAN DIOR WHITE & GOLD LARGE FOLDABLE GIFT BOX (EMPTY BOX)"),
  true
);

// --- Numbered-edition core-name preservation (e.g. "Off White Solution
// No. 1"..."No. 4") -- confirmed directly against production data as a
// real bug: contentTokens' blanket "strip bare digits" rule was
// silently dropping the ONLY thing distinguishing four different real
// UPCs, collapsing them into one identical identity signature. ---
check(
  "'No. 1' vs 'No. 4' produce DIFFERENT core-name tokens (positive: distinguishing edition number preserved)",
  JSON.stringify(extractAttributes("OFF WHITE SOLUTION No. 1 3.4 EDP U", "OFF WHITE").coreNameTokens) ===
    JSON.stringify(extractAttributes("OFF WHITE SOLUTION No. 4 3.4 EDP U", "OFF WHITE").coreNameTokens),
  false
);
check(
  "'No 1' vs 'No 8' (no period) also produce DIFFERENT core-name tokens",
  JSON.stringify(extractAttributes("TAIF AL EMARAT ROMANCE No 1 2.5 EDP U", "TAIF AL EMARAT").coreNameTokens) ===
    JSON.stringify(extractAttributes("TAIF AL EMARAT ROMANCE No 8 2.5 EDP U", "TAIF AL EMARAT").coreNameTokens),
  false
);
check(
  "the edition number itself is actually present as a token (not just 'different somehow')",
  extractAttributes("OFF WHITE SOLUTION No. 1 3.4 EDP U", "OFF WHITE").coreNameTokens.includes("1"),
  true
);
check(
  "negative: a bare number NOT preceded by No./No/Number is still stripped as noise (unchanged prior behavior)",
  JSON.stringify(extractAttributes("SOME BRAND FRAGRANCE 500 EDP U", "SOME BRAND").coreNameTokens) ===
    JSON.stringify(extractAttributes("SOME BRAND FRAGRANCE 999 EDP U", "SOME BRAND").coreNameTokens),
  true
);
check(
  "negative: a stray quantity-shaped number elsewhere in the row is still stripped, e.g. '12pcs' itself is untouched but a loose count is not treated as an edition number",
  extractAttributes("SOME BRAND FRAGRANCE 100ML EDP 12 PIECES", "SOME BRAND").coreNameTokens.includes("12"),
  false
);

// --- Bare "SET" gift-set detection (no "gift"/"of" qualifier) --
// confirmed directly against production data as a real bug: every
// Dolce & Gabbana Devotion bundle row was parsing as isGiftSet=false,
// meaning the hard gate meant to stop a bundle being treated as (or
// matched against) its primary component's standalone bottle wasn't
// firing at all for this common wording. ---
check(
  "bare 'SET' + multiple '+'-joined components -> isGiftSet true",
  extractAttributes("DOLCE & GABBANA DEVOTION (W) SET EDP 100ML + SG 50ML + BL 50ML", "DOLCE & GABBANA").isGiftSet,
  true
);
check(
  "'PCS SET' (plural) + '+'-joined components -> isGiftSet true",
  extractAttributes("D&G DEVOTION POUR HOMME 3 PCS SET 3.3 Oz EAU DE PARFUM SPR+1.6 Oz S.GEL+2.6 Oz DEO STICK", "D&G").isGiftSet,
  true
);
check(
  "negative: a standalone bottle with no '+' and no set-shaped word stays isGiftSet false",
  extractAttributes("DOLCE & GABBANA DEVOTION (W) EDP 100ML", "DOLCE & GABBANA").isGiftSet,
  false
);
check(
  "negative: a standalone bottle whose description happens to contain '+' for an unrelated reason, but no 'set' word, stays isGiftSet false",
  extractAttributes("SOME BRAND FRAGRANCE 100ML EDP (A+ GRADE)", "SOME BRAND").isGiftSet,
  false
);
check(
  "existing 'gift set' phrasing still recognized (unchanged prior behavior)",
  extractAttributes("CHANEL COCO GIFT SET EDP 100ML", "CHANEL").isGiftSet,
  true
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
