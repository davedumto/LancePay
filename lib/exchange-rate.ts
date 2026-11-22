/**
 * USD to NGN Exchange Rate Provider & Caching Service
 *
 * Caching & Concurrency Architecture:
 * - Module-Level TTL Cache: Successfully fetched rates are cached in memory for 15 minutes (900s).
 * - In-Flight Request Deduplication: When the cache is cold or expired under concurrent load,
 *   a single in-flight Promise is shared among all simultaneous callers to prevent thundering-herd
 *   stampedes and avoid exceeding exchangerate-api.com rate limits and quota.
 * - Stale-While-Revalidate Resiliency: If a network or upstream provider error occurs while refreshing
 *   an expired cache, the last known good rate is preserved and served as stale data (stale: true,
 *   fromCache: true) rather than immediately falling back to the hardcoded default.
 * - Fallback Default: Returns FALLBACK_RATE (1600 NGN) only if no live or cached rate exists.
 */

const API_KEY = process.env.EXCHANGE_RATE_API_KEY;

export const FALLBACK_RATE = 1600;
export const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes in milliseconds

export type ExchangeRateResult = {
  rate: number;
  lastUpdated: string;
  fromCache: boolean;
  fallback?: boolean;
  stale?: boolean;
};

let cachedRate: number | null = null;
let lastFetched: number | null = null;
let inFlightPromise: Promise<ExchangeRateResult> | null = null;

/**
 * Resets the in-memory cache and in-flight promise. Exported primarily for unit testing.
 */
export function resetExchangeRateCache(): void {
  cachedRate = null;
  lastFetched = null;
  inFlightPromise = null;
}

/**
 * Manually seeds the cache. Useful for test environments.
 */
export function setCachedExchangeRate(rate: number, timestamp: number): void {
  cachedRate = rate;
  lastFetched = timestamp;
}

async function fetchExchangeRateFromProvider(): Promise<number> {
  const apiKey = process.env.EXCHANGE_RATE_API_KEY || API_KEY;
  if (!apiKey) {
    throw new Error("Missing EXCHANGE_RATE_API_KEY");
  }

  const res = await fetch(
    `https://v6.exchangerate-api.com/v6/${apiKey}/latest/USD`,
    { next: { revalidate: 900 } }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch exchange rate: HTTP ${res.status}`);
  }

  const data = await res.json();
  const rate = data?.conversion_rates?.NGN;

  if (typeof rate !== "number" || isNaN(rate) || rate <= 0) {
    throw new Error("Valid NGN conversion rate not found in response");
  }

  return rate;
}

export async function getUsdToNgnRate(): Promise<ExchangeRateResult> {
  const now = Date.now();

  // Return fresh cached rate if still within TTL
  if (cachedRate !== null && lastFetched !== null && now - lastFetched < CACHE_DURATION) {
    return {
      rate: cachedRate,
      lastUpdated: new Date(lastFetched).toISOString(),
      fromCache: true,
    };
  }

  // Deduplicate concurrent in-flight requests
  if (inFlightPromise) {
    return inFlightPromise;
  }

  const apiKey = process.env.EXCHANGE_RATE_API_KEY || API_KEY;
  if (!apiKey) {
    if (cachedRate !== null && lastFetched !== null) {
      return {
        rate: cachedRate,
        lastUpdated: new Date(lastFetched).toISOString(),
        fromCache: true,
        stale: true,
      };
    }
    return {
      rate: FALLBACK_RATE,
      lastUpdated: new Date().toISOString(),
      fromCache: false,
      fallback: true,
    };
  }

  inFlightPromise = (async () => {
    try {
      const rate = await fetchExchangeRateFromProvider();
      const fetchTime = Date.now();

      cachedRate = rate;
      lastFetched = fetchTime;

      return {
        rate,
        lastUpdated: new Date(fetchTime).toISOString(),
        fromCache: false,
      };
    } catch (error) {
      console.error("Exchange rate fetch failed:", error);

      // Stale-while-revalidate: return previous good rate if available
      if (cachedRate !== null && lastFetched !== null) {
        return {
          rate: cachedRate,
          lastUpdated: new Date(lastFetched).toISOString(),
          fromCache: true,
          stale: true,
        };
      }

      // Hard fallback if no previous rate exists
      return {
        rate: FALLBACK_RATE,
        lastUpdated: new Date().toISOString(),
        fromCache: false,
        fallback: true,
      };
    } finally {
      inFlightPromise = null;
    }
  })();

  return inFlightPromise;
}
