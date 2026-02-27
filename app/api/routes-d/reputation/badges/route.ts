import { NextRequest, NextResponse } from "next/server";
import type { AuthTokenClaims } from "@privy-io/server-auth";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { getUserBadgeStatus, checkBadgeEligibility, BadgeCriteria } from "@/lib/badges";
import { issueSoulboundBadge } from "@/lib/stellar";
import { logger } from '@/lib/logger'

async function getOrCreateUser(claims: AuthTokenClaims) {
  let user = await prisma.user.findUnique({ where: { privyId: claims.userId } });

  if (!user) {
    const email = (claims as { email?: string }).email || `${claims.userId}@privy.local`;
    user = await prisma.user.create({
      data: {
        privyId: claims.userId,
        email,
      },
    });
  }

  return user;
}

/**
 * GET /api/routes-d/reputation/badges
 * Get all badges with user's eligibility and earned status
 */
export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!authToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const user = await getOrCreateUser(claims);

    // Get all badges with user's eligibility status
    const badges = await getUserBadgeStatus(user.id);

    return NextResponse.json({ badges });
  } catch (error) {
    logger.error({ err: error }, "Badges GET error:");
    return NextResponse.json(
      { error: "Failed to get badges" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/routes-d/reputation/badges
 * Claim a badge by minting a soulbound token
 */
export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!authToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const user = await getOrCreateUser(claims);

    const body = await request.json();
    const { badgeId, trustlineSubmitted } = body;

    if (!badgeId) {
      return NextResponse.json(
        { error: "badgeId is required" },
        { status: 400 },
      );
    }

    if (!trustlineSubmitted) {
      return NextResponse.json(
        {
          error: "Trustline must be created first. Call POST /api/routes-d/reputation/badges/prepare-trustline to get the unsigned XDR, sign it with your wallet, submit it to Stellar, then retry with trustlineSubmitted: true.",
        },
        { status: 400 },
      );
    }

    // Check if badge exists
    const badge = await prisma.badgeDefinition.findUnique({
      where: { id: badgeId },
    });

    if (!badge) {
      return NextResponse.json(
        { error: "Badge not found" },
        { status: 404 },
      );
    }

    if (!badge.isActive) {
      return NextResponse.json(
        { error: "Badge is no longer available" },
        { status: 400 },
      );
    }

    // Check if user already has this badge
    const existingBadge = await prisma.userBadge.findUnique({
      where: {
        userId_badgeId: {
          userId: user.id,
          badgeId: badge.id,
        },
      },
    });

    if (existingBadge) {
      return NextResponse.json(
        { error: "Badge already claimed" },
        { status: 409 },
      );
    }

    // Check eligibility
    const criteria = badge.criteriaJson as unknown as BadgeCriteria;
    const eligibility = await checkBadgeEligibility(user.id, criteria);

    if (!eligibility.eligible) {
      return NextResponse.json(
        {
          error: "Not eligible for this badge",
          reason: eligibility.reason,
        },
        { status: 403 },
      );
    }

    // Get user's wallet
    const wallet = await prisma.wallet.findUnique({
      where: { userId: user.id },
    });

    if (!wallet) {
      return NextResponse.json(
        { error: "User wallet not found. Please set up your wallet first." },
        { status: 400 },
      );
    }

    // Get the badge issuer secret key from environment
    const issuerSecretKey = process.env.BADGE_ISSUER_SECRET_KEY;
    if (!issuerSecretKey) {
      logger.error("BADGE_ISSUER_SECRET_KEY not configured");
      return NextResponse.json(
        { error: "Badge minting not configured" },
        { status: 500 },
      );
    }

    // Mint and send the soulbound badge token
    try {
      const txHash = await issueSoulboundBadge(
        issuerSecretKey,
        wallet.address,
        badge.stellarAssetCode,
        `${badge.name} badge`,
      );

      // Record the badge in database
      const userBadge = await prisma.userBadge.create({
        data: {
          userId: user.id,
          badgeId: badge.id,
          stellarTxHash: txHash,
        },
        include: {
          badge: true,
        },
      });

      return NextResponse.json(
        {
          message: "Badge claimed successfully",
          badge: userBadge,
          txHash,
        },
        { status: 201 },
      );
    } catch (stellarError: any) {
      logger.error({ err: stellarError }, "Stellar badge minting error:");
      return NextResponse.json(
        {
          error: "Failed to mint badge on Stellar",
          details: stellarError.message,
        },
        { status: 500 },
      );
    }
  } catch (error) {
    logger.error({ err: error }, "Badges POST error:");
    return NextResponse.json(
      { error: "Failed to claim badge" },
      { status: 500 },
    );
  }
}
