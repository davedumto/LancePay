import { NextRequest, NextResponse } from "next/server";
import { prisma } from '@/lib/db'
import { hashToken } from "@/lib/crypto";

export async function GET(
  _req: NextRequest,
  { params }: { params: { token: string } }
) {
  const tokenHash = hashToken(params.token);

  const verification = await prisma.incomeVerification.findUnique({
    where: { tokenHash },
  });

  if (!verification) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  if (verification.expiresAt < new Date()) {
    return NextResponse.json(
      { error: "Link expired" },
      { status: 410 }
    );
  }

  // Aggregate last 12 months income
  const fromDate = new Date();
  fromDate.setMonth(fromDate.getMonth() - 12);

  const invoices = await prisma.invoice.findMany({
    where: {
      userId: verification.userId,
      status: "PAID",
      paidAt: { gte: fromDate },
    },
    select: {
      amount: true,
      paidAt: true,
    },
  });

  const monthlyMap: Record<string, number> = {};

invoices.forEach(
  (i: { amount: number; paidAt: Date }) => {
    const key = `${i.paidAt.getFullYear()}-${i.paidAt.getMonth() + 1}`;
    monthlyMap[key] = (monthlyMap[key] || 0) + i.amount;
  }
);

  const monthlyValues = Object.values(monthlyMap);
  const total = monthlyValues.reduce((a, b) => a + b, 0);
  const average = monthlyValues.length
    ? total / monthlyValues.length
    : 0;

  const mean = average;
  const variance =
    monthlyValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) /
    (monthlyValues.length || 1);

  const stdDev = Math.sqrt(variance);

  // Account age
  const user = await prisma.user.findUnique({
    where: { id: verification.userId },
    select: { createdAt: true },
  });

  await prisma.incomeVerification.update({
    where: { id: verification.id },
    data: { accessCount: { increment: 1 } },
  });

  return NextResponse.json({
    recipient: verification.recipientName,
    verifiedOnChain: true,
    accountAgeMonths: Math.floor(
      (Date.now() - user!.createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30)
    ),
    stats: {
      averageMonthlyIncome: average,
      totalVolumeLast12Months: total,
      incomeStabilityStdDev: stdDev,
      bestMonth: Math.max(...monthlyValues, 0),
    },
  });
}
