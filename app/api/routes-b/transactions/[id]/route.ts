import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { checkResourceOwnership } from '../../_lib/access-control'

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  if (!authToken)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const claims = await verifyAuthToken(authToken);
  if (!claims)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  });
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const transaction = await prisma.transaction.findUnique({
    where: { id },
  });

  if (!transaction)
    return NextResponse.json(
      { error: "Transaction not found" },
      { status: 404 },
    );

  const accessCheck = checkResourceOwnership(transaction.userId, user.id);
  if (accessCheck) return accessCheck;

  return NextResponse.json({
    transaction: {
      id: transaction.id,
      type: transaction.type,
      status: transaction.status,
      amount: Number(transaction.amount),
      currency: transaction.currency,
      description: transaction.error ?? null,
      stellarTxHash: transaction.txHash ?? null,
      createdAt: transaction.createdAt,
    },
  });
}

export const GET = withRequestId(GETHandler)
