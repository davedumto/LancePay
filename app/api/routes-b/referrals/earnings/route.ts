import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

type ReferralEarningDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
};

function getReferralEarningDelegate(): ReferralEarningDelegate {
  return (prisma as unknown as { referralEarning: ReferralEarningDelegate }).referralEarning;
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  if (!authToken) return null;
  const claims = await verifyAuthToken(authToken);
  if (!claims) return null;
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  });
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const limit = searchParams.get("limit");
    const offset = searchParams.get("offset");

    const where: Record<string, unknown> = { referrerId: user.id };
    if (status !== null) {
      where.status = status;
    }

    const take = limit !== null ? Math.min(parseInt(limit, 10), 100) : 50;
    const skip = offset !== null ? parseInt(offset, 10) : 0;

    if (!isNaN(take) && take > 0) {
      // valid
    } else {
      // no-op, keep default
    }

    const [earnings, total] = await Promise.all([
      getReferralEarningDelegate().findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: isNaN(take) || take <= 0 ? 50 : take,
        skip: isNaN(skip) || skip < 0 ? 0 : skip,
        select: {
          id: true,
          referredUserId: true,
          invoiceId: true,
          amountUsdc: true,
          platformFee: true,
          status: true,
          createdAt: true,
        },
      }),
      (prisma as unknown as { referralEarning: { count: (args: Record<string, unknown>) => Promise<number> } }).referralEarning.count({ where }),
    ]);

    return NextResponse.json({
      earnings: earnings.map((e) => ({
        id: e.id,
        referredUserId: e.referredUserId,
        invoiceId: e.invoiceId,
        amountUsdc: (e.amountUsdc as { toString: () => string }).toString(),
        platformFee: (e.platformFee as { toString: () => string }).toString(),
        status: e.status,
        createdAt: e.createdAt,
      })),
      pagination: {
        total,
        limit: isNaN(take) || take <= 0 ? 50 : take,
        offset: isNaN(skip) || skip < 0 ? 0 : skip,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "GET /api/routes-b/referrals/earnings error");
    return NextResponse.json(
      { error: "Failed to fetch referral earnings" },
      { status: 500 },
    );
  }
}