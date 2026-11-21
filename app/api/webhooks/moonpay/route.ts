import { NextRequest, NextResponse } from "next/server";
import { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "@/lib/db";
import { sendPaymentReceivedEmail, sendAdminAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";
import { verifyMoonPaySignatureV2 } from "@/lib/moonpay-signature";

const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

function getToleranceSeconds(): number {
  const configured = Number(process.env.MOONPAY_WEBHOOK_TOLERANCE_SECONDS);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
}

export async function POST(request: NextRequest) {
  try {
    // Step 1: Read raw body and verify webhook signature
    const rawBody = await request.text();
    const signature = request.headers.get("moonpay-signature-v2") ?? "";
    const secret = process.env.MOONPAY_WEBHOOK_KEY ?? "";

    if (
      !verifyMoonPaySignatureV2(
        rawBody,
        signature,
        secret,
        getToleranceSeconds(),
      )
    ) {
      console.warn("MoonPay webhook: invalid signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Step 2: Parse the verified body
    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    logger.info({ eventType: event.type }, "MoonPay webhook");

    if (
      event.type !== "transaction_completed" &&
      event.data?.status !== "completed"
    ) {
      return NextResponse.json({ received: true });
    }

    const invoiceNumber = event.data?.externalTransactionId;
    const moonPayTransactionId = event.data?.id;
    const settledAmount = event.data?.quoteCurrencyAmount;
    const settledCurrency = event.data?.quoteCurrency;

    if (!invoiceNumber) return NextResponse.json({ received: true });

    // Check idempotency: if transaction already exists for this MoonPay id, skip
    if (moonPayTransactionId) {
      const existing = await prisma.transaction.findUnique({
        where: { externalId: moonPayTransactionId },
      });
      if (existing) {
        logger.info(
          { moonPayTransactionId, existingTxId: existing.id },
          "MoonPay webhook: idempotent duplicate, skipping",
        );
        return NextResponse.json({ received: true });
      }
    }

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber },
      include: {
        user: {
          select: { id: true, email: true, name: true },
        },
      },
    });

    if (!invoice || invoice.status === "paid")
      return NextResponse.json({ received: true });

    // Validate amount and currency
    const invoiceAmountDecimal = new Decimal(invoice.amount);
    const settledAmountDecimal = settledAmount
      ? new Decimal(settledAmount)
      : null;

    const currencyMismatch =
      settledCurrency && settledCurrency !== invoice.currency;
    const amountMismatch =
      settledAmountDecimal &&
      !settledAmountDecimal.equals(invoiceAmountDecimal);
    const hasPaymentIssue = currencyMismatch || amountMismatch;

    if (hasPaymentIssue) {
      // Flag for admin review instead of marking paid
      logger.warn(
        {
          invoiceNumber,
          invoiceAmount: invoice.amount,
          invoiceCurrency: invoice.currency,
          settledAmount,
          settledCurrency,
          moonPayTransactionId,
        },
        "MoonPay webhook: payment amount or currency mismatch",
      );

      // Create admin alert
      await prisma.structuringFlag.create({
        data: {
          userId: invoice.userId,
          status: "open",
          reason: `MoonPay payment mismatch for invoice ${invoice.invoiceNumber}. Expected: ${invoice.amount} ${invoice.currency}. Received: ${settledAmount} ${settledCurrency}. MoonPay txn: ${moonPayTransactionId}`,
          totalAmount: settledAmountDecimal || undefined,
        },
      });

      // Send alert email to admins
      try {
        await sendAdminAlertEmail({
          subject: "MoonPay Payment Mismatch Alert",
          message: `Invoice ${invoiceNumber}: Amount/currency mismatch detected. Expected ${invoice.amount} ${invoice.currency}, received ${settledAmount} ${settledCurrency}. MoonPay txn ID: ${moonPayTransactionId}`,
        });
      } catch (emailErr) {
        logger.error({ err: emailErr }, "Failed to send admin alert email");
      }

      return NextResponse.json({ received: true });
    }

    // Amount and currency match - proceed with payment
    const settled = await prisma.$transaction(async (tx: any) => {
      const now = new Date();

      const updateResult = await tx.invoice.updateMany({
        where: { id: invoice.id, status: "pending" },
        data: { status: "paid", paidAt: now },
      });

      if (updateResult.count === 0) return false;

      await tx.transaction.create({
        data: {
          userId: invoice.userId,
          type: "payment",
          status: "completed",
          amount: invoice.amount,
          currency: invoice.currency,
          invoiceId: invoice.id,
          completedAt: now,
          externalId: moonPayTransactionId || undefined,
        },
      });

      return true;
    });

    if (!settled) return NextResponse.json({ received: true });

    if (invoice.user.email) {
      await sendPaymentReceivedEmail({
        to: invoice.user.email,
        freelancerName: invoice.user.name || "Freelancer",
        clientName: invoice.clientName || "Client",
        invoiceNumber: invoice.invoiceNumber,
        amount: Number(invoice.amount),
        currency: invoice.currency,
      });
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    logger.error({ err: error }, "MoonPay webhook error");
    return NextResponse.json({ received: true });
  }
}
