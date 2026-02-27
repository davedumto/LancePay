import { NextRequest, NextResponse } from "next/server";
import {
  canMergeAccount,
  cleanupAndMergeAccount,
  calculateRecoverableXLM,
} from "@/lib/account-merge";
import { Keypair } from "@stellar/stellar-sdk";
import { logger } from '@/lib/logger'

/**
 * GET /api/account/merge/check
 * Check if account can be merged
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const publicKey = searchParams.get("publicKey");

    if (!publicKey) {
      return NextResponse.json(
        { error: "Public key required" },
        { status: 400 },
      );
    }

    const checkResult = await canMergeAccount(publicKey);
    const recoverableXLM = await calculateRecoverableXLM(publicKey);

    return NextResponse.json({
      ...checkResult,
      recoverableXLM,
    });
  } catch (error) {
    logger.error({ err: error }, "Error checking account merge eligibility:");
    return NextResponse.json(
      { error: "Failed to check account" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/account/merge
 * Merge and close account
 */
export async function POST(req: NextRequest) {
  try {
    const { secretKey, destinationAddress } = await req.json();

    if (!secretKey) {
      return NextResponse.json(
        { error: "Account secret key required" },
        { status: 400 },
      );
    }

    const accountKeypair = Keypair.fromSecret(secretKey);

    // Perform cleanup and merge
    const result = await cleanupAndMergeAccount(
      accountKeypair,
      destinationAddress,
    );

    // TODO: Mark user as deleted in database
    // TODO: Scrub sensitive personal data

    return NextResponse.json({
      message: "Account successfully merged and closed",
      ...result,
    });
  } catch (error: any) {
    logger.error({ err: error }, "Account merge error:");
    return NextResponse.json(
      { error: error.message || "Failed to merge account" },
      { status: 500 },
    );
  }
}
