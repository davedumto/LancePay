import { NextRequest, NextResponse } from "next/server";
import { getUsdToNgnRate } from "@/lib/exchange-rate";
import { server } from "@/lib/stellar";

/**
 * Fee Configuration Constants
 * These can be updated based on provider contracts
 */
const FEE_CONFIG = {
  // On-ramp fees (MoonPay/Transak)
  onRamp: {
    percentageFee: 0.035, // 3.5%
    fixedFee: 0.50, // $0.50 fixed fee
  },
  // Off-ramp fees (Yellow Card)
  offRamp: {
    percentageFee: 0.015, // 1.5%
    fixedFee: 0.25, // $0.25 fixed fee in USDC equivalent
  },
  // Stellar network fee is dynamic, fetched from network
};

/**
 * Cache for exchange rates and fees
 */
interface CacheEntry {
  data: {
    exchangeRate: number;
    stellarBaseFee: number;
    timestamp: string;
  };
  expiresAt: number;
}

let cache: CacheEntry | null = null;
const CACHE_DURATION = 60 * 1000; // 60 seconds

/**
 * Get cached or fresh exchange rate and network fees
 */
async function getRatesAndFees() {
  const now = Date.now();

  // Return from cache if still valid
  if (cache && now < cache.expiresAt) {
    return cache.data;
  }

  // Fetch fresh data
  const [rateData, stellarBaseFeeStroops] = await Promise.all([
    getUsdToNgnRate(),
    server.fetchBaseFee(),
  ]);

  // Convert Stellar base fee from stroops to XLM (1 XLM = 10,000,000 stroops)
  // Then approximate to USD (XLM is typically ~$0.10, but the fee is negligible)
  const stellarBaseFee = Number(stellarBaseFeeStroops) / 10_000_000 * 0.10;

  const data = {
    exchangeRate: rateData.rate,
    stellarBaseFee,
    timestamp: new Date().toISOString(),
  };

  // Update cache
  cache = {
    data,
    expiresAt: now + CACHE_DURATION,
  };

  return data;
}

/**
 * Calculate fee breakdown for a given USD amount
 */
function calculateFees(usdAmount: number, exchangeRate: number, stellarBaseFee: number) {
  // Step 1: Calculate on-ramp fee
  const onRampFee = (usdAmount * FEE_CONFIG.onRamp.percentageFee) + FEE_CONFIG.onRamp.fixedFee;

  // Step 2: Network fee (Stellar)
  const networkFee = stellarBaseFee;

  // Step 3: Calculate net USDC after on-ramp and network fees
  const netUsdc = usdAmount - onRampFee - networkFee;

  // Step 4: Calculate off-ramp fee
  const offRampFee = (netUsdc * FEE_CONFIG.offRamp.percentageFee) + FEE_CONFIG.offRamp.fixedFee;

  // Step 5: Final USDC after all fees
  const finalUsdc = netUsdc - offRampFee;

  // Step 6: Convert to NGN
  const finalNgnValue = finalUsdc * exchangeRate;

  // Step 7: Calculate effective rate (NGN received per USD sent)
  const effectiveRate = finalNgnValue / usdAmount;

  return {
    netUsdcValue: parseFloat(finalUsdc.toFixed(2)),
    finalNgnValue: parseFloat(finalNgnValue.toFixed(2)),
    feeBreakdown: {
      onRamp: parseFloat(onRampFee.toFixed(2)),
      network: parseFloat(networkFee.toFixed(2)),
      offRamp: parseFloat(offRampFee.toFixed(2)),
    },
    effectiveRate: parseFloat(effectiveRate.toFixed(2)),
  };
}

/**
 * GET /api/routes-d/utils/fee-quote?amount={usd_amount}
 * 
 * Returns a detailed breakdown of fees for cross-border payments
 */
export async function GET(request: NextRequest) {
  try {
    // Extract amount from query parameters
    const { searchParams } = new URL(request.url);
    const amountParam = searchParams.get("amount");

    // Validate amount parameter
    if (!amountParam) {
      return NextResponse.json(
        { error: "Missing required parameter: amount" },
        { status: 400 }
      );
    }

    const usdAmount = parseFloat(amountParam);

    // Validate amount value
    if (isNaN(usdAmount) || usdAmount <= 0) {
      return NextResponse.json(
        { error: "Amount must be a positive number" },
        { status: 400 }
      );
    }

    // Get current rates and fees
    const { exchangeRate, stellarBaseFee, timestamp } = await getRatesAndFees();

    // Calculate fee breakdown
    const calculation = calculateFees(usdAmount, exchangeRate, stellarBaseFee);

    // Return response
    return NextResponse.json({
      usdAmount: parseFloat(usdAmount.toFixed(2)),
      netUsdcValue: calculation.netUsdcValue,
      finalNgnValue: calculation.finalNgnValue,
      feeBreakdown: calculation.feeBreakdown,
      effectiveRate: calculation.effectiveRate,
      timestamp,
    });

  } catch (error) {
    console.error("Error calculating fee quote:", error);
    
    return NextResponse.json(
      { error: "Failed to calculate fee quote. Please try again later." },
      { status: 500 }
    );
  }
}
