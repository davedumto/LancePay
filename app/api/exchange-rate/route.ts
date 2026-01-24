import { NextResponse } from "next/server";
import { getUsdToNgnRate } from "@/lib/exchange-rate";

export async function GET() {
  const { rate, lastUpdated } = await getUsdToNgnRate();

  return NextResponse.json({
    rate,
    currency: "NGN",
    lastUpdated,
  });
}
