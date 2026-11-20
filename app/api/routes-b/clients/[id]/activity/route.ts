import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

export async function GET(
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

    const client = await prisma.user.findFirst({
      where: { id, role: "client" },
    });

    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const invoices = await prisma.invoice.findMany({
      where: { clientId: id, userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const totalInvoices = invoices.length;
    const totalAmount = invoices.reduce((acc, inv) => acc + (inv.amount ? Number(inv.amount) : 0), 0);
    const paidInvoices = invoices.filter((inv) => inv.status === "PAID").length;

    return NextResponse.json({
      clientId: id,
      summary: {
        totalInvoices,
        paidInvoices,
        totalAmount,
        lastActiveAt: invoices[0]?.createdAt || client.createdAt,
      },
      recentActivity: invoices.map((inv) => ({
        id: inv.id,
        type: "INVOICE",
        status: inv.status,
        amount: inv.amount,
        createdAt: inv.createdAt,
      })),
    });
  } catch (error) {
    logger.error({ err: error }, "Client activity fetch error");
    return NextResponse.json({ error: "Failed to fetch client activity" }, { status: 500 });
  }
}
