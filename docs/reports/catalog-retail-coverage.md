# Entire-catalog retail coverage — November 26, 2026

Prepared against the signed-in catalog projection supplied by the operator: 315 Product identities, including 144 in stock and 171 zero stock. No production data has been changed by preparing this branch.

| Metric | Supplied snapshot | Projected after apply |
| --- | ---: | ---: |
| Catalog products | 315 | 315 |
| Products with LIVE Notes, including existing fallback notes | 212 | 306 |
| Verified retail | 27 | 32 |
| Estimated retail | 0 | 283 |
| Explicit manual status | 0 | 0 |
| Missing usable retail price | 288 | 0 |

The three existing operator-edited verified records remain verified and unchanged. Zero explicit manual statuses does not mean operator prices were replaced. All positive priced manual edits and all existing verified records are protected. The operator explicitly authorized filling the empty Viva La Juicy Gold tester placeholder with an estimate.

## Review material

[Candidate CSV](catalog-retail-coverage.csv) lists all 315 exact identities, proposed values, reference sizes, sources and assumptions. These are candidates: existing notes and protected prices take precedence. Runtime totals come from the actual catalog, not this static report. Nine products still need note identity/composition review; existing notes and flags remain intact. New draft notes carry review flags.

Estimates are approximate named-line/brand-tier retail points, not verified MSRP. They display `~`, retain their basis and reference size, and do not use AMORUH retailPrice, costs, sales history, auction prices or discount listings. Exact sets stay separate from bottle references; unknown set contents are explicitly unverified. Ancillary products use their own type and catalog size. Supplier titles with blank concentration/size retain their original identity fields.

Verified observations retain approved source URLs and dates. MCM Diamond is $125 regular for 75 mL at [Nordstrom](https://www.nordstrom.com/s/mcm-diamond-eau-de-parfum/7977864); the $106.25 promotional price and different 100 mL MCM flankers are excluded. Other exact approved observations were checked November 20–21. Stale verified observations display as estimates until refreshed.

## Apply after operator deployment

Open `/internal/catalog-retail-coverage` while authenticated. GET previews current/projected totals without writing. “Apply / resume all batches” sends sequential batches of 25; stop after a batch or reload and resume. Exact product ID plus all seven identity fields must match. Changed/new identities are reported for follow-up. Completed rows skip on replay. Concurrent inventory or cost changes are preserved by the existing whole-catalog compare-and-set metadata writer.

Only liveNotes and retailReference are permitted to change. Inventory, costs, sale records, legacy retailPrice and the original Go Live card layout are untouched. No deployment is part of this PR.

## Validation

Hermetic full-catalog tests cover all 315 recipes, sold-out coverage, manual and note preservation, 12-batch resume/no-op replay, identity mismatches, status display, stale observations, authentication, same-origin/version guards and concurrent inventory/cost updates. Existing intake/catalog enrichment and LIVE Notes suites also pass. TypeScript, targeted ESLint and production build are checked separately before opening the PR.
