# New-intake LIVE enrichment (November 20, 2026 export)

Scope: the 56 in-stock product IDs whose latest receipt in the supplied production export belongs to intake #008 or I00293371. The fixed manifest is `src/lib/data/intake-live-enrichment.json`, ordered by newest receipt first. It contains no costs, supplier data, buyer data or quick selling lines.

## Expected changes against the reviewed export

- 28 new LIVE Notes using the existing keyNotes/vibe/bestFor format.
- Preserve the 11 existing LIVE Notes, including existing review flags.
- Leave 17 missing-note products unresolved: variant/source evidence is insufficient. No fabricated notes.
- 13 verified retail references; 43 Not verified references. All prices are regular USD prices, not sale, coupon, subscription or member prices. These are the highest verified regular prices in the approved sources checked, not a claim that every retailer was accessible.
- Product.retailPrice, inventory, costs, identity, SaleRecords, fragrance notes and quick selling lines stay unchanged.

Each proposed note fill has its source URL in the manifest. Only mainstream retailers and brand sites are used for this expedited pass; drafts sourced solely from notes databases or travel retailers were excluded. Seasons and occasions are concise editorial recommendations based on the verified scent profile, not performance guarantees.

## Verification evidence (checked November 20, 2026)

| Fragrance | Reference | Regular USD | Source / evidence |
|---|---|---:|---|
| Burberry Goddess EDP | 100 mL | 185 | Sephora SKU 2689644; corroborated Ulta SKU 2612791 |
| K EDP Intense | 100 mL | 175 | Ulta item 2620272; corroborated Nordstrom listing |
| Q EDP Intense | 100 mL | 184 | Ulta item 2620270; corroborated Nordstrom; Macy's exact page unavailable |
| Replica Jazz Club EDT | 100 mL bottle | 170 | Official US brand MM008; corroborated Nordstrom; $136 refill excluded |
| Coach Gold Parfum | 90 mL | 142 | Coach CBR68; corroborated Ulta item 2643442 and Bloomingdale's |
| Very Good Girl EDP | 150 mL | 205 | Official US brand SKU 65190111; official range 30/50/80/150 mL, no 100 mL. Sale $164 excluded |
| Le Male Elixir Absolu Parfum Intense | 200 mL | 244 | Official US brand SKU 65214879; range 75/125/200 mL, no 100 mL. Sale $183 excluded |
| 1 Million EDT (tester in inventory) | 100 mL normal retail bottle | 126 | Sephora P269120; corroborated Ulta SKU 2265045 |
| 1 Million Lucky EDT | 100 mL | 126 | Sephora SKU 2038354; corroborated Ulta SKU 2528697 |
| Afnan 9PM EDP | 100 mL | 50 | Official US storefront variant JSON: 100 mL price 3450 / compare_at_price 5000 cents; 150 mL regular $60 excluded |
| Prada Luna Rossa Sport EDT | 100 mL | 134 | Official Prada US product 2A1152_2HC9_F0Z99_P_ML100; listed unavailable/notify |
| Shaghaf Oud EDP (tester in inventory) | 75 mL normal retail bottle | 44 | Official Swiss Arabian US product shaghaf-oud-3; 75 mL standard listing, backordered; no 100 mL found in checked brand catalog |
| Givenchy Pi EDT | 100 mL | 134 | Official Givenchy US P000439 / F10100063, selected 100 mL |

Exact source URLs and product identity snapshots are stored alongside every reference in the manifest. Gift sets without approved-source UPC/contents verification remain Not verified; no bottle-only prices are substituted. Her Intense and Scandal remain unverified pending exact variant resolution. No currency conversion or discounter pricing is used.

## Apply after merge/deployment

Sign into AMORUH with the existing passcode, then open `/internal/intake-live-enrichment`. The page initially previews only. Click **Apply enrichment** to save and receive actual counts. The endpoint is `/api/internal/intake-live-enrichment`: GET previews, same-origin authenticated POST with `{ "apply": true }` applies. This implementation does not deploy or apply itself.

At apply time, each ID must still be in stock and match brand/name/concentration/size/condition/barcode/SKU exactly. Existing displayed notes (including fallback notes) and check flags are never overwritten. Existing verified, unknown-shaped or manually edited retail references are preserved. Replaying the action is a no-op for previously applied metadata. A whole-catalog CAS retries if any product changed while planning; it commits JS-serialized JSON to preserve empty arrays and all unrelated fields. No Redis reads/writes touch inventory lots, transactions, sessions or sales.

The read-only inventory export now reports real reference validity. Display requires complete allowed-source metadata, an unchanged identity and a checked date within 30 days; otherwise it says Retail: Not verified. Manual corrections are available using Edit retail in the LIVE Notes card; they save only retailReference and use optimistic concurrency. Official-source domains are brand-specific. The existing MSRP is never used as fallback.

Production credentials are not available in this development workspace. Expected counts are validated against hermetic fixtures; only the authenticated production apply response establishes actual saved counts.
