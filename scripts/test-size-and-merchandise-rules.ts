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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
