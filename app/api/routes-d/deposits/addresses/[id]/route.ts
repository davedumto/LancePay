import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

type DepositAddressDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function getDepositAddressDelegate(): DepositAddressDelegate {
  return (prisma as unknown as { depositAddress: DepositAddressDelegate }).depositAddress;
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers
      .get("authorization")
      ?.replace("Bearer ", "");
    if (!authToken)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const claims = await verifyAuthToken(authToken);
    if (!claims)
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    });
    if (!user)
      return NextResponse.json({ error: "User not found" }, { status: 404 });

    const { id } = await params;
    if (!id)
      return NextResponse.json({ error: "id is required" }, { status: 400 });

    const address = await getDepositAddressDelegate().findUnique({
      where: { id },
      select: { id: true, userId: true },
    });

    if (!address) {
      return NextResponse.json({ error: "Deposit address not found" }, { status: 404 });
    }

    if ((address as { userId: string }).userId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await getDepositAddressDelegate().update({
      where: { id },
      data: { status: "archived" },
      select: { id: true },
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    logger.error({ err: error }, "DELETE /api/routes-d/deposits/addresses/[id] error");
    return NextResponse.json(
      { error: "Failed to remove deposit address" },
      { status: 500 },
    );
  }
}