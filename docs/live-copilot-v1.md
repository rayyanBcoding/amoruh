# Compact LIVE Copilot v1

The existing Current Product panel now shows the fragrance/concentration, up to three saved scent notes, validated full-size retail reference with size, advisory per-item floor, one status, and More. More starts closed and remounts closed when the loaded product ID changes; normal polling does not close it. The three auction actions keep their existing handlers and modal. Scanner, queue, search, TikTok matching, accounting and TV components are unchanged.

## Deterministic rules

- Notes use the existing `getLiveNotesView` fallback chain; nothing is generated. Any saved check flag replaces the compact notes line with “Notes: check before quoting.” Full notes, edits and flags remain inside More.
- Retail uses `isVerifiedRetail`: approved source, current exact identity/concentration, valid positive USD reference and check within 30 days. Missing, invalid, stale or mismatched references show “Retail: Not verified”; legacy MSRP is never used.
- Floor is per actual inventory item: `ceil(max(Product.minPrice, feeAdjustedBreakEven, actualItemCost / (1 - TARGET_GROSS_MARGIN)))`. Reuse the existing financial snapshot (remaining-lot weighted landed cost, with the existing explicit legacy fallback) and Reorder's shared 15% **gross** margin target. This covers break-even and the cost-only gross-margin target; it does not promise 15% net margin after fees. Missing/invalid cost, minimum or break-even gives “Floor: Review.” Legacy cost also raises Data review. No stored price, guardrail, sale or cost-at-sale behavior changes.
- Status priority: Protect price → Data review → Low stock → Strong seller → Slow mover → Good to run. Price risk includes a current LIVE price/configured minimum below the cost-based floor, or recent real sales below that floor / below target margin. Warnings do not need enough evidence to label seller performance.
- Low stock retains the existing threshold of three units. Zero/invalid stock requires Data review.
- Strong seller uses Reorder's `Hot + Profitable` bucket and shared evidence floors (at least three units, two applicable LIVEs). Price/data warnings take priority, including incomplete historical cost coverage.
- Slow mover requires Reorder's `Weak Performer` bucket, the same evidence floors, **and** demand below the 30th percentile (the inverse tail of Reorder's 70th-percentile hot-demand cutoff). A weak profit result alone is not slow demand; absent/sparse history is never labelled slow.

## Data and speed

The card renders immediately from the existing product/financial snapshot. The existing historical-only Reorder endpoint loads independently once per session/sale revision, with a 60-second freshness backstop. Changing products does not trigger another history query; there is no AI request, supplier lookup, additional scan endpoint work or schema change. Aborted/stale revision responses are ignored. Failed history requests remove performance labels and raise Data review. Reorder reads actual real LIVE presentations and linked SaleRecords, excluding cancelled/refunded sales, over its existing default last-five-LIVEs window. Test mode uses simulated stock and session feed, but the seller classification is explicitly based on real history.

More includes full notes/vibe/best-for and retail source/date editing, image, actual size/condition, review flags, inventory/shelf, cost source, break-even/minimum, margin and status/floor explanations, last-five-LIVEs units/average per unit/gross margin, the existing latest-30-presentation session sales feed, and the existing Print Label placeholder. The session feed is labelled as limited, not lifetime history. Retail reference size may differ from the actual bottle size; the cost-based floor always applies to the actual stocked item.

## Validation

`npx tsx scripts/test-live-copilot.tsx` covers pricing/display fallbacks, warning priority, actual Reorder fixtures, cancellation/refund exclusion and default collapsed markup. `scripts/test-live-copilot-dom.tsx` documents its isolated temporary jsdom installation and tests More, focus, same-product polling, next-product collapse, immediate rendering during pending history, no per-scan history fan-out and stale-response rejection. Application dependencies are unchanged.

Also run the existing Reorder and LIVE order-ledger suites, TypeScript, targeted ESLint and the production build. All tests are local and use fake data; no production data update or deployment is part of this change.
