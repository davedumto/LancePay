import { NextRequest, NextResponse } from "next/server";
import { getClaimableBalances, getTotalClaimableAmount } from "@/lib/claimable-balances";
import { logger } from '@/lib/logger'

/**
 * GET /api/claimable-balances
 * Fetch claimable balances for authenticated user
 */
export async function GET(req: NextRequest) {
  try {
    // TODO: Get user's public key from session/auth
    const publicKey = req.headers.get("x-stellar-address");

    if (!publicKey) {
      return NextResponse.json(
        { error: "No Stellar address provided" },
        { status: 400 }
      );
    }

    const balances = await getClaimableBalances(publicKey);
    const total = await getTotalClaimableAmount(publicKey);

    return NextResponse.json({
      balances,
      total,
      count: balances.length,
    });
  } catch (error) {
    logger.error({ err: error }, "Error fetching claimable balances:");
    return NextResponse.json(
      { error: "Failed to fetch claimable balances" },
      { status: 500 }
    );
  }
}
