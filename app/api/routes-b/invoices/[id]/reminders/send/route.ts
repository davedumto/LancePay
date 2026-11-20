import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { sendInvoiceToClient } from "@/lib/email";
import crypto from "crypto";
import { AUDIT_SIGNING_SECRET } from "@/lib/audit";

// POST /api/routes-b/invoices/[id]/reminders/send — send an immediate invoice reminder

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
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
    });
    if (!user)
      return NextResponse.json({ error: "User not found" }, { status: 404 });

    const invoice = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
    });
    if (!invoice)
      return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

    if (invoice.status === "paid") {
      return NextResponse.json(
        { error: "Cannot send a reminder for an invoice that is already paid" },
        { status: 422 },
      );
    }

    if (invoice.status === "void") {
      return NextResponse.json(
        { error: "Cannot send a reminder for a void invoice" },
        { status: 422 },
      );
    }

    // Check for duplicate reminder within cooldown window (1 hour)
    const REMINDER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
    const recentReminder = await prisma.paymentReminder.findFirst({
      where: {
        invoiceId: id,
        createdAt: {
          gte: new Date(Date.now() - REMINDER_COOLDOWN_MS),
        },
      },
      orderBy: { createdAt: "desc" },
    });

    if (recentReminder) {
      return NextResponse.json(
        {
          error:
            "A reminder was recently sent for this invoice. Please wait before sending another.",
        },
        { status: 429 },
      );
    }

    const emailResult = await sendInvoiceToClient({
      clientEmail: invoice.clientEmail,
      clientName: invoice.clientName,
      freelancerName: user.name || user.email || "Your freelancer",
      invoiceNumber: invoice.invoiceNumber,
      amount: Number(invoice.amount),
      currency: invoice.currency,
      dueDate: invoice.dueDate ? invoice.dueDate.toLocaleDateString() : null,
      paymentLink: invoice.paymentLink,
    }).catch((err) => {
      logger.error({ err }, "sendInvoiceToClient failed for manual reminder");
      return { success: false, skipped: false as const };
    });

    const reminder = await prisma.paymentReminder.create({
      data: {
        invoiceId: id,
        reminderType: "manual",
      },
    });

    const metadata = { reminderId: reminder.id, manual: true };
    const signature = crypto
      .createHmac("sha256", AUDIT_SIGNING_SECRET)
      .update(JSON.stringify(metadata))
      .digest("hex");

    await prisma.auditEvent.create({
      data: {
        invoiceId: id,
        eventType: "reminder_sent",
        actorId: user.id,
        metadata,
        signature,
      },
    });

    return NextResponse.json({
      sent: emailResult.success,
      reminderId: reminder.id,
    });
  } catch (error) {
    logger.error({ err: error }, "Send invoice reminder error");
    return NextResponse.json(
      { error: "Failed to send invoice reminder" },
      { status: 500 },
    );
  }
}
