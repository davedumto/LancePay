import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const authToken = request.headers.get("authorization")?.replace("Bearer ", "");

    const claims = await verifyAuthToken(authToken || "");
    if (!claims) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    let body: { creditLimit?: number; credit_limit?: number };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const creditLimit = body.creditLimit ?? body.credit_limit;

    if (creditLimit === undefined || typeof creditLimit !== "number" || creditLimit < 0) {
      return NextResponse.json(
        { error: "creditLimit is required and must be a non-negative number" },
        { status: 400 }
      );
    }

    const client = await prisma.user.findFirst({
      where: { id, role: "client" },
    });

    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const updatedClient = await (prisma.user as any).update({
      where: { id },
      data: { creditLimit },
    });

    return NextResponse.json({
      message: "Client credit limit updated successfully",
      clientId: id,
      creditLimit: updatedClient?.creditLimit || creditLimit,
    });
  } catch (error) {
    logger.error({ err: error }, "Update credit limit error");
    return NextResponse.json({ error: "Failed to update client credit limit" }, { status: 500 });
  }
}
