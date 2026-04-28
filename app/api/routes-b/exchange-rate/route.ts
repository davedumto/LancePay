import { NextResponse } from "next/server";
let cache: { value: number; fetchedAtMs: number } | null = null;
const MAX_STALE_SECONDS = 3600;

export async function GET() {
  try {
    // fetches USD → NGN rate (USDC ≈ USD)
    const res = await fetch("https://open.er-api.com/v6/latest/USD", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error("Failed to fetch exchange rate");
    }

    const data = await res.json();

    const usdToNgn = data?.rates?.NGN;

    if (typeof usdToNgn !== "number") {
      throw new Error("Invalid rate format");
    }

    cache = { value: usdToNgn, fetchedAtMs: Date.now() };
    return NextResponse.json(
      {
        rate: {
          from: "USDC",
          to: "NGN",
          value: usdToNgn,
          source: "open.er-api.com",
          fetchedAt: new Date().toISOString(),
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("Exchange rate fetch error:", error);
    if (cache) {
      const stalenessSeconds = Math.floor((Date.now() - cache.fetchedAtMs) / 1000);
      if (stalenessSeconds <= MAX_STALE_SECONDS) {
        return NextResponse.json(
          {
            rate: {
              from: "USDC",
              to: "NGN",
              value: cache.value,
              source: "open.er-api.com",
              fetchedAt: new Date(cache.fetchedAtMs).toISOString(),
            },
            stalenessSeconds,
          },
          { status: 200, headers: { "X-Stale": "true" } }
        );
      }
    }

    return NextResponse.json(
      {
        error: "Unable to fetch exchange rate. Please try again.",
        code: "RATE_UNAVAILABLE",
      },
      { status: 503 }
    );
  }
}
