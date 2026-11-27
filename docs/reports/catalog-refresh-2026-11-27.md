# Full-catalog enrichment refresh

Prepared November 26, 2026 (US Eastern), from the operator's full post-intake JSON snapshot. The fixture/report filenames use the snapshot's November 27 UTC date. This report describes a projection; production has not been written or deployed.

| Metric | Uploaded catalog | After all batches, projected |
| --- | ---: | ---: |
| Total products | 361 | 361 |
| Products with LIVE Notes | 309 | 359 |
| Missing/unresolved notes | 52 | 2 |
| Verified retail | 32 | 34 |
| Estimated retail | 283 | 327 |
| Explicit manual retail | 0 | 0 |
| Products missing usable retail | 46 | **0** |
| In stock | 208 | 208 |
| Sold out / zero stock | 153 | 153 |

The manifest grows from 315 to 361 identities. Three previously uncovered older variants already have notes but lack retail references; they now have exact-identity recipes too. The batch changes 53 products: 50 note fills and 46 retail fills, in three batches of at most 25. All existing usable retail references, including estimates, and existing notes/review flags are unchanged against this snapshot. Legacy operator-edited verified prices remain verified; zero explicit manual statuses does not mean they were overwritten.

[Review all 53 planned updates](catalog-refresh-2026-11-27.csv). Existing 315 recipes remain for safe resumption; runtime gates use ID plus exact brand/name/concentration/size/condition/barcode/SKU. No stock filter, fuzzy identity matching, inventory/cost changes, receipt edits, matching changes, SaleRecord changes, or Product.retailPrice writes are introduced.

## Sources and estimates

Two easy exact regular USD observations were added:

- [Eilish EDP, Ulta](https://www.ulta.com/p/eilish-eau-de-parfum-with-vanilla-musk-pimprod2030620): 100 mL / 3.4 oz bottle, regular **$82**; promotional $57.40 and 5 oz refill excluded. Tester references the normal bottle.
- [Mugler A*Men Stellar EDP, official US](https://www.mugler.com/fragrance/mens-fragrances/a-men/a-men-stellar-eau-de-parfum/M020604375.html?dwvar_M020604375_size=100_ml): **100 mL $115**; 50 mL $75 excluded.

Other newly filled prices are clearly marked estimates, with a named-line retail point, labeled reference size and stored assumptions. Use 100 mL where it exists; exceptions include 75/80/90/125/150 mL standard bottles. Gift/mini sets use their own estimated bundle value and catalog contents, never a substituted bottle price. Odyssey Mega body spray uses its 200 mL ancillary format. No costs, auction history, discounted prices or AMORUH legacy MSRP are estimate inputs. Set values and uncertain largest-size assumptions remain operator-reviewable.

New notes are concise key notes / vibe / season-and-occasion cards and carry `ai_draft` + `check:true`, including suggested season/occasion judgments. Research helped resolve these identities and profiles; it does not certify every draft note or estimate:

- [Flowerbomb Extreme official barcode page](https://us.viktor-rolf.com/flowerbomb/flowerbomb-extreme-eau-de-parfum-3614273987936.html).
- [Coach Pure Platinum official](https://www.coach.com/products/pure-platinum-parfum-100-ml/CEJ65-L38.html) and [Dreams Moonlight, Nordstrom](https://www.nordstrom.com/s/dreams-moonlight-eau-de-parfum/8958983).
- [Azzaro Forever Wanted Elixir, Ulta](https://www.ulta.com/p/forever-wanted-elixir-pimprod2050973?sku=2636552). Catalog Parfum label is preserved; retail remains estimated because concentration wording differs across sources.
- [Happy AF official](https://addisonraefragrance.com/products/happy-af); 30 mL pricing and fragrance mists are not substituted for the catalog 100 mL EDP estimate.
- [Gucci Guilty men's set barcode](https://www.harveynorman.com.au/gucci-guilty-set-for-men.html), [Guilty 3-piece barcode](https://www.csmegastore.dk/i/26226732/gucci-guilty-pour-homme-eau-de-toilette-set-90ml-15ml-50ml), and [Guess Seductive Red set barcode](https://www.myperfumeshop.com.au/products/guess-seductive-red-edt-gift-set-for-her-085715350572) establish variant identity only; no prices from these sources are marked verified.
- [Original A*Men EDT barcode](https://www.blinkshop.com/en/mugler-amen-eau-de-toilette-100ml) distinguishes the older blank-concentration “A star men” record from the new Stellar EDP. Its raw identity stays unchanged.

Two note compositions remain unresolved: Carrera Jeans Original White Donna tester (8050612932130), and Guess Seductive Desire 4PC Set (085715350930). They already have estimated retail numbers. No unsupported specific scent notes were invented to hide these gaps. The unusual Coral Fantasy tester barcode is preserved; its title-based draft is flagged for operator identity review.

## Production Apply / Resume

After the operator merges/deploys this PR, open **https://amoruh.com/internal/catalog-retail-coverage** while signed in. Refresh Preview; confirm version `2026-11-27-v2` and current/projected counts. Choose **Apply / resume all batches**. Safe to stop after a batch, reload or rerun: completed rows skip; concurrent inventory/cost changes survive catalog compare-and-set retries. If production differs from the supplied snapshot, actual totals and blocked identities appear in the page. Report those saved live totals as final; do not substitute this projection.

No deployment or production apply was performed in preparing this PR.
