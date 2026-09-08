import { redis } from "./kv";

// ---------------------------------------------------------------------
// Live FX — "comparison FX" only (rule §13/§4 of the Pricing/Ordering
// spec). This is deliberately isolated behind getUsdRate() so the
// provider can change later without touching any call site.
//
// Provider: open.er-api.com (Open Exchange Rates' free, no-key API).
// Verified directly before choosing it — frankfurter.app is ECB-based
// and does NOT publish AED, which several of these Gulf-based suppliers
// plausibly quote in; open.er-api.com covers AED plus 160+ other
// currencies and updates daily, which is an appropriate cadence for
// "comparison FX" (this is a shopping-comparison rate, not a payment
// rate — ACTUAL FX, tied to a real completed order, is a distinct field
// that doesn't get built until Phase 3 real-order-cost integration).
//
// A supplier's original currency/price is NEVER overwritten by this —
// see pricing-types.ts's SupplierOfferSnapshot/Current, which keep
// `currency`/`price` untouched forever and store the USD comparison
// (and the rate + timestamp that produced it) in separate fields.
// ---------------------------------------------------------------------

const FX_PROVIDER_URL = "https://open.er-api.com/v6/latest/USD";
const CACHE_KEY = "amoruh:pricing:fx_rates_usd_base";
// The source itself only updates once a day — caching much longer than
// that just avoids a pointless refetch, not staleness beyond the
// provider's own cadence.
const CACHE_TTL_SECONDS = 6 * 60 * 60;

interface FxCache {
  rates: Record<string, number>;
  fetchedAt: string;
}

async function fetchLiveRates(): Promise<FxCache | null> {
  try {
    const res = await fetch(FX_PROVIDER_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (data.result !== "success" || !data.rates) return null;
    return { rates: data.rates, fetchedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

async function getRatesCached(): Promise<FxCache | null> {
  const cached = await redis.get<FxCache>(CACHE_KEY);
  if (cached) return cached;

  const fresh = await fetchLiveRates();
  if (fresh) {
    await redis.set(CACHE_KEY, fresh, { ex: CACHE_TTL_SECONDS });
    return fresh;
  }

  // Fetch failed and nothing cached yet — no rate available at all.
  return null;
}

export interface UsdRateResult {
  rate: number;
  timestamp: string;
}

/** USD-per-1-unit-of-`currency` rate, for comparison purposes only.
 *  Redis-cached; on a live-fetch failure, falls back to whatever was
 *  last cached (even if past its TTL) rather than failing hard — a
 *  slightly-stale comparison rate is far better than no comparison at
 *  all. Returns null only if literally nothing has ever been fetched. */
export async function getUsdRate(currency: string): Promise<UsdRateResult | null> {
  const code = currency.trim().toUpperCase();
  if (!code || code === "USD") return { rate: 1, timestamp: new Date().toISOString() };

  let cache = await getRatesCached();
  if (!cache) {
    // Even the "last cached" fallback comes up empty on a cold start —
    // try one more direct fetch before giving up.
    cache = await fetchLiveRates();
  }
  if (!cache) return null;

  // rates are USD-base (1 USD = rates[code] units of `code`), so the
  // USD value of 1 unit of `code` is the reciprocal.
  const perUsd = cache.rates[code];
  if (!perUsd || perUsd <= 0) return null;

  return { rate: 1 / perUsd, timestamp: cache.fetchedAt };
}

export function convertToUsd(amount: number, rate: number | null): number | null {
  if (rate === null) return null;
  return amount * rate;
}
