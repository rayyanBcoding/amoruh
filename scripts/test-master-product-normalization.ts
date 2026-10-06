// Persistent regression tests for the supplier-description normalization
// layer (pricing-normalize.ts + its hooks in pricing-matching.ts). No Redis
// access, no network — pure in-memory catalog. Run any time with:
//   npx tsx scripts/test-master-product-normalization.ts
import {
  extractAttributes,
  computeIdentitySignature,
  matchSupplierRow,
  buildBrandBucketedPool,
  buildMasterCandidatePool,
  type MatchRowResult,
} from "../src/lib/pricing-matching";
import { cleanDisplayName } from "../src/lib/pricing-normalize";
import type { PricingReferenceProduct } from "../src/lib/pricing-types";
import type { Product } from "../src/lib/types";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else {
    fail++;
    console.log(`FAIL: ${label}\n   expected ${JSON.stringify(expected)}\n   got      ${JSON.stringify(actual)}`);
  }
}
function ok(label: string, cond: boolean) {
  check(label, cond, true);
}

const PCA = "sup_1789721338561_2kztd8"; // Perfume Center of America
const OTHER = "sup_other";

let seq = 0;
function master(brand: string, name: string, extra: { upc?: string; supplier?: string } = {}): PricingReferenceProduct {
  const a = extractAttributes(`${brand} ${name}`, brand, { supplierId: extra.supplier });
  return {
    id: `ref_${++seq}`,
    brand,
    name,
    description: name,
    sizeMl: a.sizeMl,
    concentration: a.concentration,
    isTester: a.isTester,
    isGiftSet: a.isGiftSet,
    isRefill: a.isRefill,
    productForm: a.productForm,
    upc: extra.upc ?? "",
    ean: "",
    productId: null,
    createdAt: "",
    createdBy: "test",
    creationMethod: "auto_import",
    createdFromSupplierId: extra.supplier ?? null,
    createdFromUploadId: null,
    createdFromOfferKey: null,
  };
}

function match(catalog: PricingReferenceProduct[], description: string, o: { upc?: string; supplierId?: string; prefer?: string } = {}): MatchRowResult {
  const products: Product[] = [];
  const pool = buildBrandBucketedPool(buildMasterCandidatePool(products, catalog));
  return matchSupplierRow(
    {
      offerKey: "k",
      supplierSku: "",
      description,
      brand: "",
      upc: o.upc ?? "",
      ean: "",
      supplierId: o.supplierId,
      preferReferenceProductId: o.prefer ?? null,
    },
    products,
    [],
    catalog,
    pool
  );
}
const sig = (text: string, brand = "creed", supplierId?: string) => computeIdentitySignature(extractAttributes(`${brand} ${text}`, brand, { supplierId }));

// ======================================================================
console.log("1. Creed Aventus wording/size variants -> ONE Master Product");
// ======================================================================
const aventus = master("creed", "CREED AVENTUS 100 ML EDP");
const aventusVariants = [
  "CREED AVENTUS 100 ML EDP",
  "Creed Aventus 100ML EDP",
  "CREED - AVENTUS EDP 3.3 OZ",
  "CREED AVENTUS 3.4 OZ EDP",
  "CREED AVENTUS 3.4OZ EDP",
  "Creed Aventus 100ML EDP *NEW*",
  "Creed Aventus 100ML EDP ***NEW***",
  "CREED AVENTUS 3.4OZ EDP *** APPROVED RETAILERS ONLY ***",
  "CREED AVENTUS 3.4 EDP SPR",
  "CREED AVENTUS EDP SPRAY 100ML",
  "CREED   AVENTUS   100ML   EDP   (NEW PACK)",
];
for (const v of aventusVariants) {
  const r = match([aventus], v);
  check(`variant matches the single Master Product: ${v}`, [r.reviewStatus, r.referenceProductId], ["auto_matched", aventus.id]);
  check(`variant has the same identity signature: ${v}`, sig(v), sig("CREED AVENTUS 100 ML EDP"));
}

// ======================================================================
console.log("2. Different fragrances / formats stay SEPARATE");
// ======================================================================
const mustStaySeparate: [string, string][] = [
  ["Aventus Cologne", "CREED AVENTUS COLOGNE 100ML"],
  ["Absolu Aventus", "CREED ABSOLU AVENTUS 100ML EDP"],
  ["Aventus Tester", "CREED AVENTUS TESTER 100ML EDP"],
  ["Aventus Tester via (T) marker", "CREED AVENTUS (T) EDP 3.4oz"],
  ["Aventus Tester via TST", "CREED AVENTUS 3.4 EDP TST"],
  ["Aventus Gift Set", "CREED AVENTUS 3PC GIFT SET 100ML EDP + 10ML + SHOWER GEL"],
  ["Aventus set via 2PC list", "CREED AVENTUS 2PC 3.4 EDP SPR, 1.0 EDP SPR"],
  ["Aventus Refill", "CREED AVENTUS 100ML EDP REFILL"],
  ["Aventus EDT", "CREED AVENTUS 100ML EDT"],
  ["Aventus 50ml", "CREED AVENTUS 50ML EDP"],
];
for (const [label, text] of mustStaySeparate) {
  const r = match([aventus], text);
  ok(`${label} does NOT match the plain Aventus master (${r.reviewStatus})`, r.referenceProductId !== aventus.id && r.reviewStatus !== "auto_matched");
}

// ======================================================================
console.log("3. M vs W gender never merges");
// ======================================================================
const dareM = master("guess", "GUESS DARE (M) EDT 100ML");
const dareW = master("guess", "GUESS DARE (W) EDT 100ML");
{
  const r = match([dareM], "GUESS DARE (W) EDT 100ML");
  ok("a (W) row does not match a lone (M) master", r.referenceProductId !== dareM.id && r.reviewStatus !== "auto_matched");
  const rm = match([dareM, dareW], "GUESS DARE (M) EDT 3.4 OZ");
  check("with both masters, an (M) row picks exactly the (M) master", [rm.reviewStatus, rm.referenceProductId], ["auto_matched", dareM.id]);
  const rw = match([dareM, dareW], "GUESS DARE (W) EDT 100ML");
  check("with both masters, a (W) row picks exactly the (W) master", [rw.reviewStatus, rw.referenceProductId], ["auto_matched", dareW.id]);
  const rn = match([dareM, dareW], "GUESS DARE EDT 100ML");
  check("a row stating NO gender with both masters present goes to review", rn.reviewStatus, "needs_review");
  const ru = match([dareM], "GUESS DARE (U) EDT 100ML");
  check("(U) vs a stated (M) is review, not auto-merge", ru.reviewStatus, "needs_review");
  const rnone = match([dareM], "GUESS DARE EDT 100ML");
  check("row with no gender vs one stated master is review, not auto-merge", rnone.reviewStatus, "needs_review");
}

// ======================================================================
console.log("4. UNBOX / NO CAP / BOX DAMAGE are separate comparison buckets");
// ======================================================================
const plain = master("creed", "CREED AVENTUS 100ML EDP");
const unboxed = master("creed", "CREED AVENTUS 100ML EDP (UNBOX)");
const noCap = master("creed", "CREED AVENTUS 100ML EDP (NO CAP,BOX)");
const damaged = master("creed", "CREED AVENTUS 100ML EDP (BOX DAMAGE ONLY)");
const catalog4 = [plain, unboxed, noCap, damaged];
check("condition parsed: UNBOX", extractAttributes("creed aventus 100ml edp (unbox)", "creed").condition, "unboxed");
check("condition parsed: UN BOX", extractAttributes("creed aventus 100ml edp (un box)", "creed").condition, "unboxed");
check("condition parsed: NO CAP,BOX", extractAttributes("creed aventus 100ml edp (no cap,box)", "creed").condition, "no_cap");
check("condition parsed: NOCAP,BOX", extractAttributes("creed aventus 100ml edp (nocap,box)", "creed").condition, "no_cap");
check("condition parsed: BOX DAMAGE ONLY", extractAttributes("creed aventus 100ml edp (box damage only)", "creed").condition, "damaged_box");
check("condition parsed: standard (CAP,BOX) is not a downgrade", extractAttributes("creed aventus 100ml edp (cap,box)", "creed").condition, "standard");
check("retail row -> retail master", match(catalog4, "CREED AVENTUS 3.4 OZ EDP").referenceProductId, plain.id);
check("(UN BOX) row -> unboxed master only", match(catalog4, "CREED AVENTUS 100ML EDP (UN BOX)").referenceProductId, unboxed.id);
check("(NO CAP,BOX) row -> no-cap master only", match(catalog4, "CREED AVENTUS 3.4OZ EDP (NO CAP,BOX)").referenceProductId, noCap.id);
check("(BOX DAMAGE) row -> damaged master only", match(catalog4, "CREED AVENTUS 100ML EDP (BOX DAMAGE ONLY) *NEW*").referenceProductId, damaged.id);
ok("an unboxed row never matches the retail-only catalog", match([plain], "CREED AVENTUS 100ML EDP (UNBOX)").referenceProductId !== plain.id);
ok("a damaged-box row never matches the unboxed-only catalog", match([unboxed], "CREED AVENTUS 100ML EDP (BOX DAMAGE ONLY)").referenceProductId !== unboxed.id);
ok("signatures differ across conditions", new Set([sig("CREED AVENTUS 100ML EDP"), sig("CREED AVENTUS 100ML EDP (UNBOX)"), sig("CREED AVENTUS 100ML EDP (NO CAP,BOX)"), sig("CREED AVENTUS 100ML EDP (BOX DAMAGE ONLY)")]).size === 4);

{
  const testerCapBox = master("creed", "CREED AVENTUS (T) EDP 3.4oz (CAP,BOX)");
  const noCapRow = match([testerCapBox], "CREED AVENTUS 100ML EDP TESTER (NO CAP,BOX)");
  check("no-barcode tester NO CAP row vs tester-with-cap master => review, NOT a new Master Product", [noCapRow.reviewStatus, noCapRow.reviewReason], ["needs_review", "condition_variant_of_existing"]);
  check("...surfaced with the same-family master as the candidate", noCapRow.candidateReferenceProductId, testerCapBox.id);
  const unboxFamily = match([plain], "CREED AVENTUS 100ML EDP (UNBOX)");
  check("a no-barcode UNBOX row whose standard twin exists => review, not auto-create", [unboxFamily.reviewStatus, unboxFamily.reviewReason], ["needs_review", "condition_variant_of_existing"]);
  const firstOfKind = match([master("creed", "CREED SILVER MOUNTAIN WATER 100ML EDP")], "CREED AVENTUS 100ML EDP (UNBOX)");
  check("an UNBOX row with NO same-family master at all is simply a new candidate", firstOfKind.reviewStatus, "new_candidate");
  const stdAgainstUnboxOnly = match([unboxed], "CREED AVENTUS 100ML EDP");
  check("a standard row is not held back just because only an UNBOX twin exists", stdAgainstUnboxOnly.reviewStatus, "new_candidate");
}

// ======================================================================
console.log("5. Barcode rules: strongest signal, but compatibility-checked");
// ======================================================================
const luxe = master("jennifer lopez", "JENNIFER LOPEZ LIVE LUXE (W) EDP 100ML", { upc: "5050456081004" });
{
  const regional = match([luxe], "JENNIFER LOPEZ LIVE LUXE (W) EDP 3.4 OZ", { upc: "3414200123020" });
  check("regional different-barcode same-fragrance => REVIEW (not auto-link)", regional.reviewStatus, "needs_review");
  check("...surfaced as a review candidate pointing at the existing master", regional.candidateReferenceProductId, luxe.id);
  check("...with an explicit reason", regional.reviewReason, "regional_barcode_variant");
  check("...and no link was made", regional.referenceProductId, null);
  const kept = match([luxe], "JENNIFER LOPEZ LIVE LUXE (W) EDP 3.4 OZ", { upc: "3414200123020", prefer: luxe.id });
  check("an offer ALREADY linked to that master stays linked (stability)", [kept.reviewStatus, kept.referenceProductId], ["auto_matched", luxe.id]);
  const same = match([luxe], "LIVE LUXE BY J LO TOTALLY DIFFERENT WORDING", { upc: "5050456081004" });
  ok("same barcode with thin wording match still resolves or flags, never silently wrong", ["auto_matched", "barcode_conflict"].includes(same.reviewStatus));
  const noBarcode = match([luxe], "JENNIFER LOPEZ LIVE LUXE (W) EDP 3.4 OZ");
  check("a row with NO barcode links by unique normalized identity", [noBarcode.reviewStatus, noBarcode.referenceProductId], ["auto_matched", luxe.id]);
  const exactCode = match([luxe], "JENNIFER LOPEZ LIVE LUXE (W) EDP 100ML *NEW* ***APPROVED RETAILERS ONLY***", { upc: "5050456081004" });
  check("exact barcode wins over wording noise", [exactCode.reviewStatus, exactCode.matchType, exactCode.referenceProductId], ["auto_matched", "upc", luxe.id]);
}
{
  const avBarcode = master("creed", "CREED AVENTUS 100ML EDP", { upc: "3508440001337" });
  const tester = match([avBarcode], "CREED AVENTUS 100ML EDP TESTER", { upc: "3508440001337" });
  check("same barcode but tester vs retail => barcode_conflict, not a link", [tester.reviewStatus, tester.referenceProductId], ["barcode_conflict", null]);
  const gender = match([master("guess", "GUESS DARE (M) EDT 100ML", { upc: "085715321213" })], "GUESS DARE (W) EDT 100ML", { upc: "085715321213" });
  check("same barcode but M vs W => barcode_conflict", gender.reviewStatus, "barcode_conflict");
  const gift = match([avBarcode], "CREED AVENTUS SET EDP 100ML + EDP 10ML", { upc: "3508440001337" });
  check("same barcode but gift set vs single => barcode_conflict", gift.reviewStatus, "barcode_conflict");
  const cond = match([avBarcode], "CREED AVENTUS 100ML EDP (UNBOX)", { upc: "3508440001337" });
  check("same barcode but UNBOX vs retail => barcode_conflict", cond.reviewStatus, "barcode_conflict");
}

// ======================================================================
console.log("6. No-barcode matches require ONE unique normalized target");
// ======================================================================
{
  const twinA = master("creed", "CREED AVENTUS 100ML EDP");
  const twinB = master("creed", "CREED AVENTUS 3.4 OZ EDP *NEW*");
  const amb = match([twinA, twinB], "CREED AVENTUS EDP 100ML");
  check("two identical normalized targets => review (never guess)", [amb.reviewStatus, amb.reviewReason], ["needs_review", "multiple_exact_targets"]);
  check("...listing both competing candidates", (amb.competingCandidates ?? []).length, 2);
  const stable = match([twinA, twinB], "CREED AVENTUS EDP 100ML", { prefer: twinB.id });
  check("...unless the offer is already linked to one of them (stability)", [stable.reviewStatus, stable.referenceProductId], ["auto_matched", twinB.id]);
}

// ======================================================================
console.log("7. Unknown text stays identity-bearing; noise is only stripped when known");
// ======================================================================
check("undecorated NEW inside a name is kept (Kate Spade New York)", extractAttributes("KATE SPADE NEW YORK CHERIE EDP 100ML", "kate spade").coreNameTokens.includes("new"), true);
check("undecorated mid-name NEW is kept (Perry Ellis New)", extractAttributes("PERRY ELLIS NEW EDP 100ML", "perry ellis").coreNameTokens.includes("new"), true);
check("decorated *NEW* is stripped", extractAttributes("PERRY ELLIS 360 EDP 100ML *NEW*", "perry ellis").coreNameTokens.includes("new"), false);
check("(NEW) / [NEW PACK] are stripped", extractAttributes("TOMMY BAHAMA VERY COOL EDC 100ML (NEW)[NEW PACK]", "tommy bahama").coreNameTokens.some((t) => t === "new" || t === "pack"), false);
check("trailing NEW after a size is stripped", extractAttributes("ARMAF CLUB DE NUIT 3.4 EDP SPR NEW", "armaf").coreNameTokens.includes("new"), false);
{
  const musk = master("montale", "MONTALE ARABIANS MUSK 3.4 Oz EDP SPR [MUSK]");
  const base = master("montale", "MONTALE ARABIANS 3.4 Oz EDP SPR");
  const r = match([musk], "MONTALE ARABIANS 3.4 Oz EDP SPR");
  ok("unknown bracketed flanker text stays identity (Arabians vs Arabians [MUSK])", r.referenceProductId !== musk.id && r.reviewStatus !== "auto_matched");
  check("...and the plain one still matches itself", match([musk, base], "MONTALE ARABIANS 3.4 Oz EDP SPR").referenceProductId, base.id);
}
check("US/EU annotation (H/B) is unknown -> kept as identity", extractAttributes("DKNY (W) (H/B) EDP 100ML", "dkny").coreNameTokens.includes("h"), true);

// ======================================================================
console.log("8. LI FREE is stripped ONLY for Perfume Center");
// ======================================================================
{
  const pca = extractAttributes("TOMMY BAHAMA [M] VERY COOL 3.4 Oz EDC SPR(LI FREE)", "tommy bahama", { supplierId: PCA });
  const other = extractAttributes("TOMMY BAHAMA [M] VERY COOL 3.4 Oz EDC SPR(LI FREE)", "tommy bahama", { supplierId: OTHER });
  check("Perfume Center: LI FREE removed", pca.coreNameTokens.some((t) => t === "li" || t === "free"), false);
  check("another supplier: LI FREE stays identity-bearing", other.coreNameTokens.includes("free"), true);
  const noScope = extractAttributes("TOMMY BAHAMA [M] VERY COOL 3.4 Oz EDC SPR(LI FREE)", "tommy bahama");
  check("no supplier scope: LI FREE stays identity-bearing", noScope.coreNameTokens.includes("free"), true);
  check("'Kay Ali Freedom' is never touched even for Perfume Center", extractAttributes("KAY ALI FREEDOM MUSK SANTAL EDP 100ML", "kay ali", { supplierId: PCA }).coreNameTokens.includes("freedom"), true);
  check("PCA row and a non-PCA twin share one identity once LI FREE is stripped", sig("TOMMY BAHAMA VERY COOL (M) EDC 100ML", "tommy bahama"), sig("TOMMY BAHAMA VERY COOL(M)EDC SP 3.4oz(LI FREE)", "tommy bahama", PCA));
}

// ======================================================================
console.log("9. Detection fixes (tester / gift set / market code / spray / size numerals)");
// ======================================================================
check("(T) marker is a tester", extractAttributes("LANVIN MARRY ME(W)(T)EDP SP 2.5oz(NO CAP,BOX)", "lanvin").isTester, true);
check("TST is a tester", extractAttributes("CK IN 2 U 3.4 EDT M TST", "calvin klein").isTester, true);
check("w/o box keeps its existing tester meaning", extractAttributes("SOME FRAG 3.4 EDT W/O BOX", "x").isTester, true);
check("2PC component list is a gift set", extractAttributes("PRISME VERT by PATEK MAISON 2PC 3.0 EDP SPR, 1.0 EDP SPR (M)", "patek maison").isGiftSet, true);
check("a bare carton '15pcs ByBox' is NOT a gift set", extractAttributes("CK IN 2 U 3.4 EDT M (101091) - Spain - 15pcs ByBox", "calvin klein").isGiftSet, false);
check("'+' joined multi-size list is a set even without the word SET", extractAttributes("JEAN PAUL G SCANDAL 3.4 EDT M + 5.1 DEO SPRAY + 10ML BLACK BOX", "jean paul gaultier").isGiftSet, true);
check("'2C' piece shorthand before a size list is a set", extractAttributes("D&G Q 2C 3.3 EDP SPR, 10ML MINI (W)", "dolce & gabbana").isGiftSet, true);
check("a single bottle with one '+' free text but one size is not a set", extractAttributes("CREED AVENTUS 100ML EDP + FREE GIFT", "creed").isGiftSet, false);
// Same bundle, different supplier formats -> all detected as sets.
for (const [label, text] of [
  ["Miami 'M+ 20ML EDP+ 6.7 BS'", "LATTAFA PRIDE AFFECTION 3.4 EDP M+ 20ML EDP+ 6.7 BS  (133617) - United Arab Emir. - 20pcs ByBox"],
  ["Miami '3.4 EDP L + 10ML'", "DG DEVOTION INTENSE 3.4 EDP L + 10ML  (134496) - Italy - 6pcs ByBox"],
  ["Classic comma list '4.2 EDT SPR, 2.5 S/G'", "JEAN PAUL GAULTIER 4.2 EDT SPR, 2.5 S/G (M)"],
  ["Classic '3PC, 3.4 EDP SPR, 3.4 BL, 10ML MINI'", "212 VIP BLACK 3PC, 3.4 EDP SPR, 3.4 BL, 10ML MINI (M)"],
  ["Classic '4PC X 1.17 OZ'", "CUBA 4PC X 1.17 OZ SPRAY (BLUE, GOLD, ORANGE, RED) (MEN)"],
  ["Classic '3.3 EDP SPR, .33 MINI'", "DOLCE & GABBANA K INTENSE 3.3 EDP SPR, .33 MINI (M)"],
  ["NMD '5*0.33 Oz ... TRAVEL SET'", "CHLOE' [W] ATELIER DES FLEURS 5*0.33 Oz EDP SPR [Jasminum Sambac,Herba Mimosa] TRAVEL SET"],
  ["PCA '2PC SET(3.4oz edp sp,1.0oz edp sp)'", "TUMI KINETIC(M)(H/B)(LI FREE)2PC SET(6.8oz edp sp,1.0oz edp sp)"],
  ["spaced '3 * 0.33' without a unit", "CREED QUEEN OF SILK 3 * 0.33 EAU DE PARFUM SPRAY FOR WOMEN REFILLABLE"],
  ["glued 'SET4 PC X 4 ML'", "MINI MARC JACOBS DAISY SET4 PC X 4 ML EDT EAU SO FRESH EDT, DAISY EDT,"],
  ["repeated same-size components", "360 by PERRY ELLIS 1.0 EDT SPR, 360 CORAL 1.0 EDP SPR, 360 PURPLE 1.0 EDP SPR (W)"],
] as [string, string][]) check(`bundle detected: ${label}`, extractAttributes(text, "x").isGiftSet, true);
check("one size written two ways is NOT a set (3.4 oz = 100 ml)", extractAttributes("CREED AVENTUS EDP, 3.4 OZ 100ML", "creed").isGiftSet, false);
check("a name containing a decimal plus one size is NOT a set (Thank U Next 2.0)", extractAttributes("ARIANA GRANDE THANK U NEXT 2.0 3.4 EDP SPR", "ariana grande").isGiftSet, false);
check("asterisk multiplication sign survives noise cleanup", cleanDisplayName("MINI SET 5*0.33 Oz EDP *NEW*"), "MINI SET 5*0.33 Oz EDP");
check("LE PARFUM + trailing EDP is the Le Parfum bucket on both sides", [extractAttributes("I WANT CHOO LE PARFUM 1.4 EDP SPR", "jimmy choo").concentration, extractAttributes("I WANT CHOO LE PARFUM 1.3 Oz PARFUM SPR", "jimmy choo").concentration], ["le_parfum", "le_parfum"]);
check("ELIXIR + trailing EDP is the Elixir bucket on both sides", [extractAttributes("SAUVAGE ELIXIR 2.0 Oz EAU DE PARFUM SPR", "dior").concentration, extractAttributes("SAUVAGE ELIXIR CONCENTRATED PERFUME 60 ml", "dior").concentration], ["elixir", "elixir"]);
check("Le Parfum and plain EDP stay different products", extractAttributes("CHLOE LE PARFUM 100ML", "chloe").concentration === extractAttributes("CHLOE EDP 100ML", "chloe").concentration, false);
check("Aventus Cologne stays separate from Aventus EDP", extractAttributes("CREED AVENTUS COLOGNE 100ML", "creed").concentration === extractAttributes("CREED AVENTUS 100ML EDP", "creed").concentration, false);
check("EDP vs EXTRAIT is still a real concentration difference", extractAttributes("MANCERA RED TOBACCO INTENSE EXTRAIT DE PARFUM 120ML", "mancera").concentration === extractAttributes("MANCERA RED TOBACCO INTENSE EDP 120ML", "mancera").concentration, false);
check("a plain single bottle is not a gift set", extractAttributes("CREED AVENTUS 100ML EDP", "creed").isGiftSet, false);
check("trailing market code stripped after a size", sig("LE PARFUM LUMIERE (W) EDP 90 ml IT", "elie saab"), sig("LE PARFUM LUMIERE (W) EDP 90ML", "elie saab"));
check("a 2-letter word elsewhere is NOT treated as a market code", extractAttributes("HELLO IT GIRL EDP 100ML", "x").coreNameTokens.includes("it"), true);
check("bare size numeral is not an identity token", extractAttributes("JIMMY CHOO I WANT CHOO 3.4 EDP SPR (W)", "jimmy choo").coreNameTokens.includes("3.4"), false);
check("3.3 oz and 3.4 oz and 100 ml are one size", [extractAttributes("X 3.3 OZ EDP", "x").sizeMl, extractAttributes("X 3.4 OZ EDP", "x").sizeMl, extractAttributes("X 100ML EDP", "x").sizeMl], [100, 100, 100]);
check("genuinely different sizes stay different (1.6 oz vs 50 ml)", extractAttributes("X 1.6 OZ EDP", "x").sizeMl === extractAttributes("X 50ML EDP", "x").sizeMl, false);
check("spray stays identity for body spray (form is not fragrance)", extractAttributes("GUESS DARE BODY SPRAY 6.0 OZ", "guess").coreNameTokens.includes("spray"), true);

// ======================================================================
console.log("10. Master Product display name keeps identity, drops listing noise");
// ======================================================================
check("noise removed from display name", cleanDisplayName("JIMMY CHOO I WANT CHOO 3.4 EDP SPR (W) * NEW *"), "JIMMY CHOO I WANT CHOO 3.4 EDP SPR (W)");
check("approved-retailers + new removed", cleanDisplayName("PRISME NUIT by PATEK MAISON 3.0 EDP SPR (M) * APPROVED RETAILERS ONLY * ***NEW***"), "PRISME NUIT by PATEK MAISON 3.0 EDP SPR (M)");
check("condition marker preserved in the name", cleanDisplayName("CREED AVENTUS 100ML EDP (UNBOX) *NEW*"), "CREED AVENTUS 100ML EDP (UNBOX)");
check("tester + gender + unknown bracket preserved", cleanDisplayName("LANVIN MARRY ME(W)(T)EDP SP 2.5oz [MUSK]"), "LANVIN MARRY ME(W)(T)EDP SP 2.5oz [MUSK]");
check("LI FREE removed for Perfume Center only", [cleanDisplayName("X(M)EDT SP 3.4oz(LI FREE)", PCA), cleanDisplayName("X(M)EDT SP 3.4oz(LI FREE)", OTHER)], ["X(M)EDT SP 3.4oz", "X(M)EDT SP 3.4oz(LI FREE)"]);
check("a name that is only noise falls back to the raw text", cleanDisplayName("*NEW*"), "*NEW*");
{
  const raw = "JIMMY CHOO I WANT CHOO 3.4 EDP SPR (W) * NEW *";
  const cleaned = cleanDisplayName(raw);
  check("identity derived from the cleaned name equals identity from the raw row", sig(cleaned, "jimmy choo"), sig(raw, "jimmy choo"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
