import { NextResponse } from "next/server";
import { getUsdToNgnRate } from "@/lib/exchange-rate";

export async function GET() {
  const { rate, lastUpdated, cacheAgeMs } = await getUsdToNgnRate();

  return NextResponse.json({
    rate,
    currency: "NGN",
    lastUpdated,
    // Age of the rate in milliseconds — lets clients judge freshness.
    cacheAgeMs,
    cacheAgeSeconds: Math.floor(cacheAgeMs / 1000),
  });
}
