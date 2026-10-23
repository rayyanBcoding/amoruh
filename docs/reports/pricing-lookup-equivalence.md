<!--
Supporting evidence for PR #44 (LIVE Reorder Intelligence).
Generated 2026-10-24 by a one-off read-only script (since removed) that compared the pre-refactor
getProductOfferComparison (the code on main, unmodified) with getProductBestActionableOffer against
real supplier data. Only an allowlist of Redis read commands could run; every write threw.
The script needed buildProductOfferRows exported; that export has been reverted since it is not needed
by the implementation.
-->

# Equivalence: getProductBestActionableOffer vs full getProductOfferComparison (pre-refactor code from main), real data, read-only
Compared: 165 products (116 with linked offers; 154 surfaced by Reorder Intelligence across all windows, 32 ever in High Demand / Losing Money). Errors: 0.
Exact matches (winner + row set + actionable split + tie order): 165/165
  winner (supplier/price/USD/validity/listed/qty/freshness/review) identical: 165/165
  offer rows identical to the old loop's rows: 165/165
  actionable vs non-actionable classification identical: 165/165
Coverage of the sample: {"multiSupplier":54,"singleSupplier":62,"ties":1,"stale":67,"outOfStock":7,"notListed":52,"nonActionable":71,"unreviewed":0,"nonUsd":0,"invalidFx":0,"orphaned":42,"tester":42,"retail":123,"condNew":165,"condOther":0,"noOffers":49,"giftSet":14}
Mismatches: 0
Redis commands actually sent (reads only): 743; memo hits: 12200; FX-cache writes swallowed (never sent): 0
Timing (cached/memoized, whole sample): old full avg 2006 ms vs new fast avg 0 ms
Timing (uncached, real latency): new fast avg 959 ms over 8 products [1160, 951, 950, 903, 951, 901, 951, 903]; old full avg 117149 ms over 2 products [89791, 144506]
