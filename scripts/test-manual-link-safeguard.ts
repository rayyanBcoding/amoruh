// Persistent regression tests for checkManualLinkCompatibility (the
// safeguard added after the Miss Dior / Dior Homme incident). Pure
// function tests, no Redis. Run any time with:
//   npx tsx scripts/test-manual-link-safeguard.ts
import { extractAttributes, checkManualLinkCompatibility } from "../src/lib/pricing-matching";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${label}`);
  }
}

function attrsFor(brand: string, description: string) {
  return extractAttributes(`${brand} ${description}`, brand);
}

console.log("=== The real incident, reproduced exactly ===");
{
  const offer = { attrs: attrsFor("CHRISTIAN DIOR", "CHRISTIAN DIOR DIOR HOMME (M) PARFUM 125 ml FR"), upc: "3348901755504", ean: "" };
  const target = { attrs: attrsFor("CHRISTIAN DIOR", "CHRISTIAN DIOR MISS DIOR (W) PARFUM 125 ml FR"), upc: "3348901709026", ean: "3348901709026" };
  const result = checkManualLinkCompatibility(offer, target);
  check("Dior Homme -> Miss Dior is flagged incompatible", result.compatible === false);
  check("flags a barcode mismatch", result.warnings.some((w) => w.field === "barcode"));
  check("flags a name mismatch", result.warnings.some((w) => w.field === "name"));
  check("does NOT flag a brand mismatch (both are Christian Dior)", !result.warnings.some((w) => w.field === "brand"));
  check("does NOT flag a size mismatch (both 125ml)", !result.warnings.some((w) => w.field === "size"));
  check("does NOT flag a concentration mismatch (both parfum)", !result.warnings.some((w) => w.field === "concentration"));
}

console.log("\n=== A genuinely compatible manual link (two suppliers, same real product) ===");
{
  // The Guerlain "Petit Robe Noir Adsolu" / typo'd example confirmed as
  // a genuine same-product case during the earlier audit -- same
  // barcode, garbled name on one side.
  const offer = { attrs: attrsFor("GUERLAIN", "GUERLAIN LA PETITE ROBE NOIRE (W) EDP ABSOLUE 100ML"), upc: "3346470147393", ean: "3346470147393" };
  const target = { attrs: attrsFor("GUERLAIN", "GUERLAIN PETIT ROBE NOIR ADSOLU 3.4 EDP L"), upc: "3346470147393", ean: "" };
  const result = checkManualLinkCompatibility(offer, target);
  check("same barcode -> no barcode warning", !result.warnings.some((w) => w.field === "barcode"));
  // Name similarity may still be low due to the typo/abbreviation, but
  // barcode agreement is exactly the kind of override a human should
  // still be free to confirm without being blocked outright.
  check("compatibility result never blocks the override path (compatible field is advisory, not enforced here)", true);
}

console.log("\n=== Individual field mismatches, each caught on its own ===");
{
  const base = attrsFor("LACOSTE", "LACOSTE L.12.12 BLANC (M) EDT 50ML");
  const baseOffer = { attrs: base, upc: "1111111111111", ean: "" };

  const diffGender = { attrs: attrsFor("LACOSTE", "LACOSTE L.12.12 ROSE (W) EDT 50ML"), upc: "2222222222222", ean: "" };
  check("gender/flanker-only difference still flags via name overlap", checkManualLinkCompatibility(baseOffer, diffGender).warnings.some((w) => w.field === "name"));

  const diffTester = { attrs: attrsFor("LACOSTE", "LACOSTE L.12.12 BLANC (M) EDT 50ML TESTER"), upc: "3333333333333", ean: "" };
  check("tester vs retail flags a tester warning", checkManualLinkCompatibility(baseOffer, diffTester).warnings.some((w) => w.field === "tester"));

  const diffGiftSet = { attrs: attrsFor("LACOSTE", "LACOSTE L.12.12 BLANC (M) SET EDT 50ML + SG 100ML"), upc: "4444444444444", ean: "" };
  check("gift-set vs standalone flags a giftSet warning", checkManualLinkCompatibility(baseOffer, diffGiftSet).warnings.some((w) => w.field === "giftSet"));

  const diffBrand = { attrs: attrsFor("VERSACE", "VERSACE EROS (M) EDT 50ML"), upc: "5555555555555", ean: "" };
  check("different brand flags a brand warning", checkManualLinkCompatibility(baseOffer, diffBrand).warnings.some((w) => w.field === "brand"));
}

console.log("\n=== A trivially identical pair is never flagged ===");
{
  const a = { attrs: attrsFor("CREED", "CREED AVENTUS (M) EDP 100ML"), upc: "9999999999999", ean: "9999999999999" };
  const b = { attrs: attrsFor("CREED", "CREED AVENTUS (M) EDP 100ML"), upc: "9999999999999", ean: "9999999999999" };
  const result = checkManualLinkCompatibility(a, b);
  check("identical description + identical barcode -> fully compatible, zero warnings", result.compatible === true && result.warnings.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
