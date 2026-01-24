
const API_KEY = process.env.EXCHANGE_RATE_API_KEY;

const FALLBACK_RATE = 1600;
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes time interval

let cachedRate: number | null = null;
let lastFetched: number | null = null;

export async function getUsdToNgnRate() {
  const now = Date.now();

  // Return cached rate if still valid
  if (cachedRate && lastFetched && now - lastFetched < CACHE_DURATION) {
    return {
      rate: cachedRate,
      lastUpdated: new Date(lastFetched).toISOString(),
      fromCache: true,
    };
  }

  if (!API_KEY) {
    return {
      rate: FALLBACK_RATE,
      lastUpdated: new Date().toISOString(),
      fromCache: false,
      fallback: true,
    };
  }

  try {
    const res = await fetch(
      `https://v6.exchangerate-api.com/v6/${API_KEY}/latest/USD`,
      { next: { revalidate: 900 } }
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
    };
  } catch (error) {
    console.error("Exchange rate fetch failed:", error);

    return {
      rate: FALLBACK_RATE,
      lastUpdated: new Date().toISOString(),
      fallback: true,
    };
  }
}
