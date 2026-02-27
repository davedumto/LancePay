import { NextRequest, NextResponse } from "next/server";
import { createSplitPayment, formatFeeBreakdown } from "@/lib/revenue-split";
import { Keypair } from "@stellar/stellar-sdk";
import { logger } from '@/lib/logger'

/**
 * POST /api/payments/split
 * Process a payment with automatic platform fee splitting
 */
export async function POST(req: NextRequest) {
  try {
    const { freelancerAddress, amount, invoiceId, senderSecret } =
      await req.json();

    if (!freelancerAddress || !amount || !invoiceId) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // TODO: Get sender keypair from secure storage
    // This is placeholder - in production use proper key management
    if (!senderSecret) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const senderKeypair = Keypair.fromSecret(senderSecret);

    // Create split payment transaction
    const result = await createSplitPayment(
      senderKeypair,
      freelancerAddress,
      amount,
      invoiceId
    );

    // Get fee breakdown
    const breakdown = formatFeeBreakdown(amount);

    return NextResponse.json({
      success: true,
      transactionHash: result.hash,
      breakdown,
    });
  } catch (error) {
    logger.error({ err: error }, "Split payment error:");
    return NextResponse.json(
      { error: "Payment failed" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/payments/split/preview
 * Preview fee breakdown for an amount
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const amount = searchParams.get("amount");

    if (!amount) {
      return NextResponse.json(
        { error: "Amount required" },
        { status: 400 }
      );
    }

    const breakdown = formatFeeBreakdown(amount);

    return NextResponse.json({
      success: true,
      breakdown,
    });
  } catch (error) {
    logger.error({ err: error }, "Fee preview error:");
    return NextResponse.json(
      { error: "Failed to calculate fees" },
      { status: 500 }
    );
  }
}
