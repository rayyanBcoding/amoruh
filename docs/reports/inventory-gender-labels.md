# Inventory audience labels — November 27, 2026

Add an editable `gender` field to Product: `men`, `women`, `unisex`, or null/unset for unreviewed products. Inventory shows “Marketed for”, with an exact-category filter; the Product editor allows corrections. This is the fragrance's merchandising audience, not a restriction on who can wear it. No gender is inferred from customers, scent notes or bottle color. Unisex is an affirmative category, never a fallback for an unknown variant.

The reviewed manifest covers the last supplied **361-product full catalog**, including sold-out products: **169 Men / 148 Women / 44 Unisex**. [Review every identity and label](inventory-gender-labels.csv). Explicit M/W/U markers, recognizable marketed fragrance lines, concentration, and barcode checks distinguish variants. Ancillary products and sets follow the identified fragrance. This is a curated merchandising classification, not a claim that every row has been individually verified against a current official brand page. Operator labels take precedence.

Important barcode-specific checks:

- [Coach Signature 3386460086349 is Coach for Men](https://www.harveynorman.com.au/coach-for-men-eau-de-toilette-spray-40ml-1-3oz.html).
- [Guess Indigo 085715321961 is Men](https://www.jomashop.com/guess-mens-1981-indigo-edt-1-0-oz-fragrances-085715321961.html), and [085715005014 is Seductive Homme](https://www.nandansons.com/parlux32031a/). The 75 mL Seductive tester is the separate Women variant.
- [Clive Christian X tester 652638013152 is Women](https://www.lovenmour.co.il/en/collections/%D7%97%D7%96%D7%A8%D7%95-%D7%9C%D7%9E%D7%9C%D7%90%D7%99-1-%D7%91%D7%A9%D7%9E%D7%99-%D7%A0%D7%99%D7%A9%D7%94/products/tester-original-collection-clive-christian-x-edp-for-women-50ml).
- [Rasasi Daarej 614514177013 and Shuhrah 614514249031 are Women variants](https://www.scribd.com/document/920953747/Rasasi-Product-Master-Order-Sheet), unlike the similarly named men's bottles. [Yumn 614514438039 is Men](https://www.upcbrands.com/products/rasasi-yumn-pour-homme-3-4-oz-edp-sp).
- [Authentic Moment 085715169617 is Women](https://www.takealot.com/abercrombie-and-fitch-authentic-moment-women-edp-50ml/PLID95101596); [L'Eau d'Issey IGO 3423478971769 is Women](https://www.jomashop.com/issey-miyake-ladies-leau-dissey-i-go-edt-spray-2-7-oz-tester-fragrances-3423478971769.html).
- The two 212 testers remain separate: 8411061043882 Men and 8411061088289 Women, consistent with supplier barcode listings. [Burberry Brit 3614226905161 is Men](https://www.dm.de/p/d/2685336/burberry-brit-man-eau-de-toilette).
- [Guess Amore Roma is Unisex](https://www.corpoecapelli.it/guess-m-25.html); [Fatima Velvet Love 6290171071068 is Women](https://www.upcbrands.com/products/zimaya-precious-collection-fatima-velvet-love-women-3-4-oz-edp-sp).
- [New Brand Gold and Unic sets are Men](https://thefreshbeautyco.com/collections/new-brand/mens-fragrance); [Thameen Sugar Plum and Wild Vanille are Unisex](https://www.bjutip.com/unisex-eau-de-parfum?order=DESC&page=13&sort=p.date_added).
- [Bond Off-Broadway is Unisex](https://www.bondno9.com/products/off-broadway). [Light Blue Summer Vibes 8057971183463 is Women](https://venerafragrances.com/dolceandgabbana-light-blue-summer-vibes-edt-100ml-for-women-without-package).

The unusual Valentino Coral Fantasy barcode remains unchanged; the label follows the named Uomo EDT identity. It remains reviewable in Inventory. No other product data is corrected opportunistically.

## Apply after merge/deployment

Open **https://amoruh.com/internal/catalog-gender** while signed in (also linked as “Fill audience labels” from Inventory). Refresh preview and confirm batch `2026-11-27-v1`. Click **Apply / resume all labels**. It saves up to 25 products per request and continues to completion; it is safe to stop and resume. A 361-product catalog with no existing labels takes 15 batches. The saved totals should show **Missing: 0**. Refresh Inventory to see the labels.

The authenticated GET previews without writing. POST checks same origin, version and limit, then uses whole-catalog CAS. A separate narrow writer asserts that **only gender can change**. Existing notes/reference metadata, costs, quantities, receipt/intake fields, sales and Product.retailPrice are protected. The previous notes/retail writer still cannot change gender. Concurrent edits trigger retry; existing operator categories survive. New or changed product identities outside the reviewed manifest remain unset and are listed for review rather than guessed.

No production deployment or data apply is performed by this PR. Production totals may differ from the last snapshot; use the page's live current/projected/saved counts.

## Validation

Full 361-row recipe and preservation tests; sold-out scope; exact variant regressions; manual label preservation; unknown/changed identity blocks; enum validation; create/update persistence; real Lua CAS retry with concurrent stock/cost edits; auth/origin/version/limit guards; read-only preview; resumable/idempotent apply. DOM tests exercise all audience filters including Men vs Women and confirm filtering performs no inventory writes. Existing notes/retail enrichment and intake creation suites remain part of validation.
