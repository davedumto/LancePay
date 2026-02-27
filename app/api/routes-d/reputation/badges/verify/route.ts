import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hasBadge, getWalletBadges } from "@/lib/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { logger } from '@/lib/logger'

/**
 * GET /api/routes-d/reputation/badges/verify?userId=xxx&badgeId=yyy
 * Public API to verify badge ownership
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");
    const badgeId = searchParams.get("badgeId");

    if (!userId || !badgeId) {
      return NextResponse.json(
        { error: "userId and badgeId are required" },
        { status: 400 },
      );
    }

    // Get the user badge record
    const userBadge = await prisma.userBadge.findUnique({
      where: {
        userId_badgeId: {
          userId,
          badgeId,
        },
      },
      include: {
        badge: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!userBadge) {
      return NextResponse.json(
        {
          verified: false,
          message: "Badge not found for this user",
        },
        { status: 200 },
      );
    }

    // Get user's wallet
    const wallet = await prisma.wallet.findUnique({
      where: { userId },
    });

    if (!wallet) {
      return NextResponse.json(
        {
          verified: false,
          message: "User wallet not found",
        },
        { status: 200 },
      );
    }

    // Get issuer public key from secret
    const issuerSecretKey = process.env.BADGE_ISSUER_SECRET_KEY;
    if (!issuerSecretKey) {
      return NextResponse.json(
        { error: "Badge verification not configured" },
        { status: 500 },
      );
    }

    const issuerKeypair = Keypair.fromSecret(issuerSecretKey);
    const issuerPublicKey = issuerKeypair.publicKey();

    // Verify badge ownership on Stellar network
    const hasOnChainBadge = await hasBadge(
      wallet.address,
      userBadge.badge.stellarAssetCode,
      issuerPublicKey,
    );

    // Fetch all LancePay badges visible in the wallet so external wallets
    // (Lobstr, Solar, etc.) can surface the same on-chain data.
    let walletBadges: Awaited<ReturnType<typeof getWalletBadges>> = [];
    try {
      walletBadges = await getWalletBadges(wallet.address, issuerPublicKey);
    } catch {
      // Non-fatal: on-chain badge list is supplemental to DB verification.
    }

    return NextResponse.json({
      verified: hasOnChainBadge,
      badge: {
        id: userBadge.badge.id,
        name: userBadge.badge.name,
        description: userBadge.badge.description,
        imageUrl: userBadge.badge.imageUrl,
        assetCode: userBadge.badge.stellarAssetCode,
      },
      user: {
        id: userBadge.user.id,
        name: userBadge.user.name,
        email: userBadge.user.email,
      },
      issuedAt: userBadge.issuedAt,
      stellarTxHash: userBadge.stellarTxHash,
      walletAddress: wallet.address,
      issuerPublicKey,
      // All LancePay soulbound badges visible in the wallet at query time.
      // External wallets display these as standard Stellar custom assets.
      walletBadges,
    });
  } catch (error) {
    logger.error({ err: error }, "Badge verification error:");
    return NextResponse.json(
      { error: "Failed to verify badge" },
      { status: 500 },
    );
  }
}
