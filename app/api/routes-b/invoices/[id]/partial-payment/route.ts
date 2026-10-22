import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

export async function POST(
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

    let body: { amount?: number; paymentMethod?: string; reference?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.amount || typeof body.amount !== "number" || body.amount <= 0) {
      return NextResponse.json(
        { error: "amount is required and must be a positive number" },
        { status: 400 }
      );
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
    });

    if (!invoice) {
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    }

    const previousPaidAmount = (invoice as any).paidAmount || 0;
    const newPaidAmount = previousPaidAmount + body.amount;
    const totalAmount = Number(invoice.amount) || 0;
    const newStatus = newPaidAmount >= totalAmount ? "PAID" : "PARTIALLY_PAID";

    const updatedInvoice = await (prisma as any).invoice.update({
      where: { id },
      data: {
        paidAmount: newPaidAmount,
        status: newStatus,
      },
    });

    return NextResponse.json({
      message: "Partial payment recorded successfully",
      invoiceId: id,
      payment: {
        amountPaid: body.amount,
        totalPaidAmount: updatedInvoice.paidAmount,
        remainingBalance: Math.max(0, totalAmount - newPaidAmount),
        status: updatedInvoice.status,
        paymentMethod: body.paymentMethod || "MANUAL",
        reference: body.reference || null,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Record partial payment error");
    return NextResponse.json({ error: "Failed to record partial payment" }, { status: 500 });
  }
}
