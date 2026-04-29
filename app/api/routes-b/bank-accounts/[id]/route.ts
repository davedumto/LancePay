import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";

export async function GET(
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

  const bankAccount = await prisma.bankAccount.findUnique({
    where: { id },
  });

  if (!bankAccount)
    return NextResponse.json(
      { error: "Bank account not found" },
      { status: 404 },
    );

  if (bankAccount.userId !== user.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  return NextResponse.json({
    bankAccount: {
      id: bankAccount.id,
      bankName: bankAccount.bankName,
      bankCode: bankAccount.bankCode,
      accountNumber: bankAccount.accountNumber,
      accountName: bankAccount.accountName,
      isDefault: bankAccount.isDefault,
      createdAt: bankAccount.createdAt,
    },
  });
}

export async function PATCH(
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

  const body = await request.json().catch(() => null);
  if (!body || body.isDefault !== true) {
    return NextResponse.json(
      { error: "PATCH body must include { isDefault: true }" },
      { status: 400 },
    );
  }

  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account)
    return NextResponse.json(
      { error: "Bank account not found" },
      { status: 404 },
    );
  if (account.userId !== user.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.bankAccount.updateMany({
      where: { userId: user.id, isDefault: true },
      data: { isDefault: false },
    });

    return tx.bankAccount.update({
      where: { id: account.id },
      data: { isDefault: true },
      select: {
        id: true,
        bankName: true,
        bankCode: true,
        accountNumber: true,
        accountName: true,
        isDefault: true,
        createdAt: true,
      },
    });
  });

  return NextResponse.json({ bankAccount: updated });
}

export async function DELETE(
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

  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account)
    return NextResponse.json(
      { error: "Bank account not found" },
      { status: 404 },
    );
  if (account.userId !== user.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const result = await prisma.$transaction(async (tx) => {
    const deleted = await tx.bankAccount.delete({
      where: { id: account.id },
      select: { id: true, isDefault: true },
    });

    if (!deleted.isDefault) {
      return { deletedId: deleted.id, promotedId: null };
    }

    const remaining = await tx.bankAccount.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        createdAt: true,
        withdrawals: {
          where: { type: "withdrawal" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { createdAt: true },
        },
      },
    });

    if (remaining.length === 0) {
      return { deletedId: deleted.id, promotedId: null };
    }

    const nextDefault = remaining
      .map((item) => ({
        id: item.id,
        score:
          item.withdrawals[0]?.createdAt.getTime() ?? item.createdAt.getTime(),
      }))
      .sort((a, b) => b.score - a.score)[0];

    await tx.bankAccount.updateMany({
      where: { userId: user.id },
      data: { isDefault: false },
    });

    await tx.bankAccount.update({
      where: { id: nextDefault.id },
      data: { isDefault: true },
    });

    return { deletedId: deleted.id, promotedId: nextDefault.id };
  });

  return NextResponse.json(result);
}
