// Every tunable of LIVE Reorder Intelligence, in one place. The scoring code
// (reorder-intelligence.ts) and the UI import from here — no threshold is
// repeated anywhere else, so tuning means editing this file only.

/** Reorder Score weights (sum to 1). A missing profit component is dropped and
 *  the other two are re-scaled proportionally (see scoreProducts). */
export const SCORE_WEIGHTS = { demand: 0.4, profit: 0.35, consistency: 0.25 } as const;

/** Consistency is `LIVEs sold ÷ applicable LIVEs` (applicable = LIVEs from the
 *  product's first sale in the window to the newest LIVE). It is multiplied by
 *  a confidence that ramps with the evidence available: 1 LIVE = low, 2–3 =
 *  partial, 4+ = full. */
export const CONSISTENCY_CONFIDENCE_BY_LIVES: readonly number[] = [0, 0.35, 0.6, 0.8, 1];
export const FULL_CONFIDENCE_LIVES = 4;

/** Below either floor a product is "New / Not Enough Data". */
export const MIN_UNITS_FOR_CONFIDENCE = 3;
export const MIN_APPLICABLE_LIVES_FOR_CONFIDENCE = 2;

/** A product whose costed units cover less than this share of its units has
 *  "Cost Unknown": its profit is excluded from the score. At or above it, profit
 *  is measured on the costed sales and flagged as partial coverage. */
export const COST_KNOWN_MIN_COVERAGE = 0.5;

/** Bucket thresholds. Demand and Profit are percentile ranks (0–100) among the
 *  products in the selected window; Consistency is the ramped 0–100 value. */
export const BUCKETS = {
  hotDemandMin: 70,
  hotProfitMin: 70,
  hotConsistencyMin: 60,
  /** Hot also needs a real margin, so a high-volume 7% product isn't "Hot". */
  hotMinMargin: 0.1,
  /** Sells often (demand ≥ this) but earns little per sale. */
  thinMarginDemandMin: 65,
  thinMarginMaxMargin: 0.12,
  thinMarginMaxProfitPerUnit: 3,
  /** Strong total profit (percentile ≥ this) that isn't Hot: it earns well but
   *  doesn't move consistently enough to stock aggressively. */
  highProfitMin: 70,
  /** Loses money AND sells often: a pricing/cost problem, not a weak product. */
  losingMoneyDemandMin: 60,
  steadyConsistencyMin: 60,
  steadyMinMargin: 0.1,
} as const;

/** A product with negative gross profit never reaches the top of the list: its
 *  score is capped here (the uncapped value stays visible in the breakdown). */
export const LOSING_MONEY_SCORE_CAP = 45;

/** Reorder quantity — conservative by design. Expected demand =
 *  avg units per applicable LIVE × horizon, scaled down by consistency,
 *  minus current stock, never more than was sold in the window. */
export const REORDER = {
  horizonLives: 4,
  /** qty multiplier = floor + (1 - floor) × consistency(0–1) */
  consistencyFloor: 0.5,
  capAtUnitsSoldInWindow: true,
} as const;

/** Summary-card list sizes. */
export const TOP_CANDIDATES_COUNT = 5;

export type WindowKey = "last3" | "last5" | "last10" | "7d" | "30d" | "all";

export const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: "last3", label: "Last 3 LIVEs" },
  { key: "last5", label: "Last 5 LIVEs" },
  { key: "last10", label: "Last 10 LIVEs" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "all", label: "All time" },
];
export const DEFAULT_WINDOW: WindowKey = "last5";
