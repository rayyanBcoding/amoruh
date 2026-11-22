# Current in-stock catalog LIVE review

Reviewed the supplied production export from November 21, 2026, 10:18 p.m. America/New_York (2026-11-22T03:18:17.162Z). All 177 in-stock identities were reviewed. This document records staged work, not successful production writes.

## Baseline and projected results

| Metric | Supplied production export | Projected after safe apply |
|---|---:|---:|
| In-stock products | 177 | 177 |
| Complete LIVE Notes | 165 | 166 |
| Unresolved LIVE Notes | 12 | 11 |
| Verified retail references | 13 | 25 |
| Not verified, including missing records | 164 | 152 |
| Missing retail records | 130 | 0 |

Projection assumes stock and exact identities still match, including empty barcode representations. Actual results come from the authenticated preview/apply response. Existing manual/verified records and all notes/review flags are preserved; no guess-based fills. A product whose barcode is absent in the export is staged with the existing string-model empty value; any differing actual stored identity skips the entire row.

## Twelve additional verified references

These are the highest confidently verified regular USD prices found, not a claim that every retailer was accessible. Search coverage includes the approved mainstream retailers and official sites. Primary selected-size product pages were opened for every staged verified value. Subscription, refill, coupon, sale, marketplace-seller and bundle prices were excluded. Gift sets without exact verified contents remain unverified.

| Inventory product | Concentration | Reference size | Regular USD | Source |
|---|---|---|---:|---|
| Burberry London (50ml) | Eau de Toilette | 100 mL | $112 | [Official brand website](https://us.burberry.com/burberry-london-eau-de-toilette-100ml-p34547291) |
| Burberry London (3.3oz) | Eau de Toilette | 100 mL | $112 | [Official brand website](https://us.burberry.com/burberry-london-eau-de-toilette-100ml-p34547291) |
| Coach Coach for Men (Tester) (3.4oz) | Eau de Toilette | 100 mL | $116 | [Ulta](https://www.ulta.com/p/men-eau-de-toilette-xlsImpprod16841001) |
| Burberry London (Fabric) (Tester) EDP (3.3oz) | Eau de Parfum | 100 mL | $148 | [Official brand website](https://us.burberry.com/burberry-london-eau-de-parfum-100ml-p34547261) |
| Yves Saint Laurent Y (3.4oz) | Eau de Parfum | 100 mL | $170 | [Ulta](https://www.ulta.com/p/y-eau-de-parfum-pimprod2000239?sku=2534072) |
| Coach Coach Man Blue (2.0oz) | Eau de Toilette | 100 mL | $116 | [Ulta](https://www.ulta.com/p/man-blue-eau-de-toilette-pimprod2016062?sku=2566616) |
| Ariana Grande Moonlight (Tester) (3.4oz) | Eau de Parfum | 100 mL | $75 | [Ulta](https://www.ulta.com/p/moonlight-eau-de-parfum-xlsImpprod16841019?sku=2515152) |
| Ariana Grande Moonlight (Tester) (3.4oz) | Eau de Parfum | 100 mL | $75 | [Ulta](https://www.ulta.com/p/moonlight-eau-de-parfum-xlsImpprod16841019?sku=2515152) |
| Mont Blanc Legend (Tester) (3.4oz) | Eau de Toilette | 100 mL | $112 | [Ulta](https://www.ulta.com/p/legend-eau-de-toilette-xlsImpprod4320001) |
| Burberry Goddess (Tester) (3.3oz) | Parfum | 100 mL | $204 | [Official brand website](https://us.burberry.com/burberry-goddess-parfum-100ml-p40851871) |
| Coach Floral (3.0oz) | Eau de Parfum | 90 mL | $132 | [Ulta](https://www.ulta.com/p/floral-eau-de-parfum-xlsImpprod17391231) |
| Gucci Flora Gorgeous Jasmine (3.3oz) | Eau de Parfum | 100 mL | $188 | [Ulta](https://www.ulta.com/p/flora-gorgeous-jasmine-eau-de-parfum-pimprod2034290?sku=2599239) |

Coach Floral uses the largest standard bottle, 90 mL; its official 90 mL listing agrees with Ulta at $132: https://www.coach.com/products/floral-eau-de-parfum-90-ml/B1011-L38.html . Burberry London EDT is currently unavailable on its official site; the posted regular reference price is retained and this availability is recorded. All prices were checked November 21, 2026.

## LIVE Notes

One confident new fill: Ferragamo F by Ferragamo Free Time EDT. Key notes: pink pepper, ginger, white cedarwood, vetiver. Vibe: fresh, woody, easygoing. Best for: spring/summer; daytime, office or casual wear. The seasonal/occasion guidance is editorial selling guidance, not a retailer claim. Source: https://www.nordstrom.com/s/f-by-ferragamo-free-time-eau-de-toilette/3275284 .

The following remain unresolved rather than inventing notes or silently resolving names:

- Salvatore Ferragamo Subtil — Eau de Toilette, 3.4oz (exact interpretation or adequate scent evidence not established).
- Juicy Couture Viva La Juicy Gold (Tester) — Eau de Parfum, 3.4oz (exact interpretation or adequate scent evidence not established).
- Salvatore Ferragamo Incanto Charm — Eau de Toilette, 3.4oz (exact interpretation or adequate scent evidence not established).
- Salvatore Ferragamo Incanto Shine — Eau de Toilette, 3.4oz (exact interpretation or adequate scent evidence not established).
- Lattafa Raed Absolu — Eau de Parfum, 3.4oz (exact interpretation or adequate scent evidence not established).
- Hugo Boss Hugo Green — Eau de Toilette, 2.5oz (exact interpretation or adequate scent evidence not established).
- Hugo Boss Hugo XX — Eau de Toilette, 3.4oz (exact interpretation or adequate scent evidence not established).
- Jean Paul Gaultier Scandal — Eau de Parfum Intense, 3.4oz (exact interpretation or adequate scent evidence not established).
- Gucci Guilty 3PC Set — Eau de Toilette, 3.0oz (exact interpretation or adequate scent evidence not established).
- Guess Girl 3PC Set — Eau de Toilette, 3.4oz (exact interpretation or adequate scent evidence not established).
- Guess Seductive Red 2PC Set — Eau de Toilette, 2.5oz (exact interpretation or adequate scent evidence not established).

## Apply without touching inventory/accounting

The original 56-product mode remains unchanged. Catalog scope is explicit:

1. Merge and deploy this scoped change through the normal operator workflow; this task does not deploy it.
2. While signed in, open `/internal/intake-live-enrichment?scope=catalog`.
3. Review **Projected catalog totals — not saved**, then use **Apply enrichment** once.
4. Record the returned totals and download `/api/internal/inventory-export` again. Replays preserve existing enrichment.

The same protected metadata CAS updater re-reads stock and exact identity on each retry and asserts that all non-enrichment product fields are unchanged. No general product PUT, stock mutation, cost mutation, sales-history mutation or legacy retailPrice mutation is used. Automated Not verified records remain `manuallyEdited: false`, allowing future research; the operator-edit endpoint would mark every automated record manual, so it is not used for this bulk job.

A successful replay means zero new writes; it does not mean missing notes or Not verified prices became verified. New products outside the reviewed snapshot are reported separately. The TV legacy MSRP/savings behavior is outside this change; its displayed price still does not prove a verified Retail Reference.

## Validation

Run `npm_config_cache=/tmp/amoruh-npm-cache npx --yes tsx scripts/test-catalog-live-enrichment.ts` and the existing `scripts/test-intake-live-enrichment.ts`, plus TypeScript and targeted ESLint. Tests use fake Redis and never access production.
