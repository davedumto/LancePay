const API_KEY = process.env.EXCHANGE_RATE_API_KEY;

const FALLBACK_RATE = 1600;

/**
 * Single source of truth for how long an exchange rate is considered fresh.
 * Used both for the in-process cache check below and for the Next.js fetch
 * `revalidate` window (converted to seconds), so the two can never drift
 * apart. Documented in docs/FEE_QUOTE_API.md.
 */
export const EXCHANGE_RATE_CACHE_TTL_MS = 60 * 1000; // 60 seconds

const FETCH_REVALIDATE_SECONDS = Math.floor(EXCHANGE_RATE_CACHE_TTL_MS / 1000);

let cachedRate: number | null = null;
let lastFetched: number | null = null;

export interface UsdToNgnRateResult {
  rate: number;
  lastUpdated: string;
  fromCache: boolean;
  fallback?: boolean;
  /**
   * Age of the returned rate in milliseconds — how stale the quote is.
   * 0 for a freshly fetched rate; callers should surface this so clients
   * can see rate freshness.
   */
  cacheAgeMs: number;
}

function rateAgeMs(fetchedAt: number): number {
  return Math.max(0, Date.now() - fetchedAt);
}

export async function getUsdToNgnRate(): Promise<UsdToNgnRateResult> {
  const now = Date.now();

  // Return cached rate if still valid
  if (cachedRate && lastFetched && now - lastFetched < EXCHANGE_RATE_CACHE_TTL_MS) {
    return {
      rate: cachedRate,
      lastUpdated: new Date(lastFetched).toISOString(),
      fromCache: true,
      cacheAgeMs: rateAgeMs(lastFetched),
    };
  }

  if (!API_KEY) {
    return {
      rate: FALLBACK_RATE,
      lastUpdated: new Date().toISOString(),
      fromCache: false,
      fallback: true,
      cacheAgeMs: 0,
    };
  }

  try {
    const res = await fetch(
      `https://v6.exchangerate-api.com/v6/${API_KEY}/latest/USD`,
      { next: { revalidate: FETCH_REVALIDATE_SECONDS } }
    );

    if (!res.ok) {
      throw new Error("Failed to fetch exchange rate");
    }

    const data = await res.json();
    const rate = data?.conversion_rates?.NGN;

    if (!rate) {
      throw new Error("NGN rate not found");
    }

    // Cache result
    cachedRate = rate;
    lastFetched = now;

    return {
      rate,
      lastUpdated: new Date(now).toISOString(),
      fromCache: false,
      cacheAgeMs: 0,
    };
  } catch (error) {
    console.error("Exchange rate fetch failed:", error);

    // A stale cached rate is better than the fallback constant when the
    // provider is down — report its real age so callers can judge freshness.
    if (cachedRate && lastFetched) {
      return {
        rate: cachedRate,
        lastUpdated: new Date(lastFetched).toISOString(),
        fromCache: true,
        fallback: true,
        cacheAgeMs: rateAgeMs(lastFetched),
      };
    }

    return {
      rate: FALLBACK_RATE,
      lastUpdated: new Date().toISOString(),
      fallback: true,
      cacheAgeMs: 0,
    };
  }
}
