import { randomBytes } from "crypto";
import { prisma } from "./db";
import { Decimal } from "@prisma/client/runtime/library";

const PLATFORM_FEE_RATE = 0.01;
const REFERRAL_COMMISSION_RATE = 0.1;

export function generateReferralCode(): string {
  const prefix = "LANCE";
  const random = randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${random}`;
}

export async function ensureReferralCode(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true },
  });

  if (user?.referralCode) {
    return user.referralCode;
  }

  let code = generateReferralCode();
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { referralCode: code },
        select: { referralCode: true },
      });
      return updated.referralCode!;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        code = generateReferralCode();
        attempts++;
        continue;
      }
      throw error;
    }
  }

  throw new Error("Failed to generate unique referral code");
}

export async function findUserByReferralCode(code: string) {
  return prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true },
  });
}

export function calculateReferralCommission(invoiceAmount: number): {
  platformFee: number;
  referralCommission: number;
} {
  const platformFee = invoiceAmount * PLATFORM_FEE_RATE;
  const referralCommission = platformFee * REFERRAL_COMMISSION_RATE;

  return {
    platformFee,
    referralCommission,
  };
}

export async function createReferralEarning(data: {
  referrerId: string;
  referredUserId: string;
  invoiceId: string;
  invoiceAmount: number;
}) {
  const { platformFee, referralCommission } = calculateReferralCommission(
    data.invoiceAmount,
  );

  return prisma.referralEarning.create({
    data: {
      referrerId: data.referrerId,
      referredUserId: data.referredUserId,
      invoiceId: data.invoiceId,
      amountUsdc: new Decimal(referralCommission),
      platformFee: new Decimal(platformFee),
      status: "earned",
    },
  });
}

export async function getReferralStats(userId: string) {
  const [totalReferred, earnings] = await Promise.all([
    prisma.user.count({
      where: { referredById: userId },
    }),
    prisma.referralEarning.aggregate({
      where: { referrerId: userId },
      _sum: { amountUsdc: true },
    }),
  ]);

  const totalEarned = earnings._sum.amountUsdc || new Decimal(0);

  const pendingSum = await prisma.referralEarning.aggregate({
    where: {
      referrerId: userId,
      status: "earned",
    },
    _sum: { amountUsdc: true },
  });

  const pendingPayout = pendingSum._sum.amountUsdc || new Decimal(0);

  return {
    totalReferred,
    totalEarnedUsdc: Number(totalEarned),
    pendingPayout: Number(pendingPayout),
  };
}

export async function getRecentReferralHistory(
  userId: string,
  limit: number = 10,
) {
  const earnings = await prisma.referralEarning.findMany({
    where: { referrerId: userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      referredUser: {
        select: { email: true },
      },
    },
  });

  return earnings.map((earning) => ({
    date: earning.createdAt.toISOString().split("T")[0],
    user: maskEmail(earning.referredUser.email),
    earned: Number(earning.amountUsdc),
  }));
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }
  return `${local[0]}***@${domain}`;
}
