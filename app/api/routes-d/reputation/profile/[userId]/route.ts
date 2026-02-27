import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { logger } from '@/lib/logger'

/**
 * GET /api/routes-d/reputation/profile/[userId]
 * Get public badge profile for a user
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const { userId } = await params;

    // Get user info
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Get user's earned badges
    const earnedBadges = await prisma.userBadge.findMany({
      where: { userId },
      include: {
        badge: {
          select: {
            id: true,
            name: true,
            description: true,
            imageUrl: true,
            stellarAssetCode: true,
            createdAt: true,
          },
        },
      },
      orderBy: {
        issuedAt: "desc",
      },
    });

    // Get user statistics
    const stats = await getUserStats(userId);

    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        memberSince: user.createdAt,
      },
      badges: earnedBadges.map((ub) => ({
        id: ub.badge.id,
        name: ub.badge.name,
        description: ub.badge.description,
        imageUrl: ub.badge.imageUrl,
        assetCode: ub.badge.stellarAssetCode,
        earnedAt: ub.issuedAt,
        txHash: ub.stellarTxHash,
        verificationUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/routes-d/reputation/badges/verify?userId=${userId}&badgeId=${ub.badgeId}`,
      })),
      stats,
    });
  } catch (error) {
    logger.error({ err: error }, "Badge profile error:");
    return NextResponse.json(
      { error: "Failed to get badge profile" },
      { status: 500 },
    );
  }
}

async function getUserStats(userId: string) {
  const [totalRevenue, invoiceCount, disputeCount] = await Promise.all([
    prisma.transaction.aggregate({
      where: {
        userId,
        type: "payment",
        status: "completed",
      },
      _sum: {
        amount: true,
      },
    }),
    prisma.invoice.count({
      where: {
        userId,
        status: "paid",
      },
    }),
    prisma.dispute.count({
      where: {
        invoice: {
          userId,
        },
      },
    }),
  ]);

  const revenue = totalRevenue._sum.amount
    ? parseFloat(totalRevenue._sum.amount.toString())
    : 0;

  return {
    totalRevenue: revenue,
    completedInvoices: invoiceCount,
    disputes: disputeCount,
    badgeCount: await prisma.userBadge.count({ where: { userId } }),
  };
}
