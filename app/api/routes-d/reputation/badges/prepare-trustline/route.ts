import { NextRequest, NextResponse } from "next/server";
import type { AuthTokenClaims } from "@privy-io/server-auth";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { checkBadgeEligibility, BadgeCriteria } from "@/lib/badges";
import { prepareBadgeTrustlineXdr } from "@/lib/stellar";
import { Keypair } from "@stellar/stellar-sdk";
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
 * POST /api/routes-d/reputation/badges/prepare-trustline
 *
 * Step 1 of the non-custodial badge claim flow.
 * Validates eligibility and returns an unsigned changeTrust XDR for the
 * recipient to sign via WalletConnect and submit to Stellar themselves.
 * After submission, the client calls POST /api/routes-d/reputation/badges
 * with { badgeId, trustlineSubmitted: true } to complete steps 2 & 3.
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
    const { badgeId } = body;

    if (!badgeId) {
      return NextResponse.json({ error: "badgeId is required" }, { status: 400 });
    }

    const badge = await prisma.badgeDefinition.findUnique({
      where: { id: badgeId },
    });

    if (!badge) {
      return NextResponse.json({ error: "Badge not found" }, { status: 404 });
    }

    if (!badge.isActive) {
      return NextResponse.json({ error: "Badge is no longer available" }, { status: 400 });
    }

    const existingBadge = await prisma.userBadge.findUnique({
      where: { userId_badgeId: { userId: user.id, badgeId: badge.id } },
    });

    if (existingBadge) {
      return NextResponse.json({ error: "Badge already claimed" }, { status: 409 });
    }

    const criteria = badge.criteriaJson as unknown as BadgeCriteria;
    const eligibility = await checkBadgeEligibility(user.id, criteria);

    if (!eligibility.eligible) {
      return NextResponse.json(
        { error: "Not eligible for this badge", reason: eligibility.reason },
        { status: 403 },
      );
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } });

    if (!wallet) {
      return NextResponse.json(
        { error: "User wallet not found. Please set up your wallet first." },
        { status: 400 },
      );
    }

    const issuerSecretKey = process.env.BADGE_ISSUER_SECRET_KEY;
    if (!issuerSecretKey) {
      logger.error("BADGE_ISSUER_SECRET_KEY not configured");
      return NextResponse.json({ error: "Badge minting not configured" }, { status: 500 });
    }

    const issuerPublicKey = Keypair.fromSecret(issuerSecretKey).publicKey();

    const xdr = await prepareBadgeTrustlineXdr(
      wallet.address,
      issuerPublicKey,
      badge.stellarAssetCode,
      `${badge.name} badge`,
    );

    return NextResponse.json({ xdr, badgeId });
  } catch (error) {
    logger.error({ err: error }, "Prepare trustline error:");
    return NextResponse.json({ error: "Failed to prepare trustline" }, { status: 500 });
  }
}
