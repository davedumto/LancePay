import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { randomBytes } from "crypto";
import { hashToken } from "@/lib/crypto";
import { logger } from '@/lib/logger'

// POST /api/routes-d/finance/income-proof
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { recipientName, durationDays } = body;

    if (!recipientName || !durationDays) {
      return NextResponse.json(
        { error: "recipientName and durationDays are required" },
        { status: 400 },
      );
    }

    // Generate a random token
    const token = randomBytes(16).toString("hex");
    const tokenHash = hashToken(token);

    // Set expiration
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + durationDays);

    // Save to DB
    const verification = await prisma.incomeVerification.create({
      data: {
        userId: "replace-with-user-id", // TODO: replace with authenticated user ID
        recipientName,
        tokenHash,
        expiresAt,
      },
    });

    const verificationUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/api/routes-d/finance/income-proof/public/${token}`;

    return NextResponse.json({
      verificationUrl,
      expiresAt: verification.expiresAt,
    });
  } catch (err) {
    logger.error(err);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
