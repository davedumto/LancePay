import { NextRequest, NextResponse } from "next/server";
import { claimBalance } from "@/lib/claimable-balances";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * POST /api/claim
 * Claim a claimable balance
 */
export async function POST(req: NextRequest) {
  try {
    const { balanceId } = await req.json();

    if (!balanceId) {
      return NextResponse.json(
        { error: "Balance ID required" },
        { status: 400 }
      );
    }

    // TODO: Get user's keypair from secure storage
    // This is placeholder - in production, use proper key management
    const secretKey = req.headers.get("x-stellar-secret");
    if (!secretKey) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const keypair = Keypair.fromSecret(secretKey);
    const result = await claimBalance(keypair, balanceId);

    return NextResponse.json({
      success: true,
      transactionHash: result.hash,
    });
  } catch (error) {
    console.error("Error claiming balance:", error);
    return NextResponse.json(
      { error: "Failed to claim balance" },
      { status: 500 }
    );
  }
}
