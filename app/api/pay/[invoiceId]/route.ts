/**
 * @swagger
 * /api/pay/{invoiceId}:
 *   get:
 *     summary: Get invoice details for payment
 *     description: Retrieves public invoice data for a payer to review before submitting payment. Also fires an invoice.viewed webhook.
 *     tags:
 *       - Payments
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema:
 *           type: string
 *         description: The invoice number (public-facing ID)
 *     responses:
 *       200:
 *         description: Invoice details returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 invoiceNumber:
 *                   type: string
 *                 freelancerName:
 *                   type: string
 *                 description:
 *                   type: string
 *                 amount:
 *                   type: number
 *                 status:
 *                   type: string
 *                   enum: [pending, paid, cancelled]
 *                 dueDate:
 *                   type: string
 *                   format: date-time
 *                 walletAddress:
 *                   type: string
 *       404:
 *         description: Invoice not found
 *   post:
 *     summary: Mark invoice as paid
 *     description: Confirms payment for an invoice. Triggers referral earnings, savings auto-deduction, waterfall distributions, auto-swap, and trust score update.
 *     tags:
 *       - Payments
 *     parameters:
 *       - in: path
 *         name: invoiceId
 *         required: true
 *         schema:
 *           type: string
 *         description: The invoice number
 *     responses:
 *       200:
 *         description: Invoice marked as paid
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       400:
 *         description: Invalid or already-paid invoice
 *       500:
 *         description: Internal server error
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createReferralEarning } from "@/lib/referral";
import { dispatchWebhooks } from "@/lib/webhooks";
import { updateUserTrustScore } from "@/lib/reputation";
import { logAuditEvent, extractRequestMetadata } from "@/lib/audit";
import { processSavingsOnPayment } from "@/lib/savings";
import { processWaterfallPayments } from "@/lib/waterfall";
import { processAdvanceRepayment } from "@/lib/advance-repayment";
import { logger } from '@/lib/logger'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { invoiceNumber: invoiceId },
    include: {
      user: { select: { name: true, wallet: { select: { address: true } } } },
    },
  });

  if (!invoice)
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  // Log audit event for invoice view (async, non-blocking)
  logAuditEvent(
    invoice.id,
    "invoice.viewed",
    null,
    extractRequestMetadata(request.headers),
  ).catch((error) => {
    logger.error({ err: error }, "Failed to log invoice.viewed audit event:");
  });

  // Dispatch webhook for invoice.viewed event (async, non-blocking)
  dispatchWebhooks(invoice.userId, "invoice.viewed", {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    clientEmail: invoice.clientEmail,
    viewedAt: new Date().toISOString(),
  }).catch((error) => {
    logger.error({ err: error }, "Failed to dispatch invoice.viewed webhook:");
  });

  return NextResponse.json({
    invoiceNumber: invoice.invoiceNumber,
    freelancerName: invoice.user.name || "Freelancer",
    description: invoice.description,
    amount: Number(invoice.amount),
    status: invoice.status,
    dueDate: invoice.dueDate,
    walletAddress: invoice.user.wallet?.address,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ invoiceId: string }> },
) {
  const { invoiceId } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { invoiceNumber: invoiceId },
    include: {
      user: {
        select: {
          id: true,
          referredById: true,
        },
      },
    },
  });

  if (!invoice || invoice.status !== "pending") {
    return NextResponse.json({ error: "Invalid invoice" }, { status: 400 });
  }

  // Keep invoice settlement atomic and ordered to avoid payout races.
  const paymentResult = await prisma.$transaction(async (tx: any) => {
    const now = new Date();

    const updateResult = await tx.invoice.updateMany({
      where: { id: invoice.id, status: "pending" },
      data: { status: "paid", paidAt: now },
    });

    if (updateResult.count === 0) {
      return {
        updatedInvoice: null,
        advanceRepayment: {
          processed: false,
          repaidAmount: 0,
          remainingAmount: Number(invoice.amount),
        },
        waterfallResult: {
          processed: false,
          leadShare: Number(invoice.amount),
          distributions: [],
        },
      };
    }

    await tx.transaction.create({
      data: {
        userId: invoice.userId,
        type: "incoming",
        status: "completed",
        amount: invoice.amount,
        currency: invoice.currency,
        invoiceId: invoice.id,
        completedAt: now,
      },
    });

    // Log audit event for payment within transaction
    await logAuditEvent(
      invoice.id,
      "invoice.paid",
      null,
      extractRequestMetadata(request.headers),
      tx,
    );

    const advanceRepayment = await processAdvanceRepayment(
      tx,
      invoice.id,
      Number(invoice.amount),
    );

    const waterfallResult = await processWaterfallPayments(
      invoice.id,
      advanceRepayment.remainingAmount,
      tx,
    );

    // Return the updated invoice with user data
    const updatedInvoice = await tx.invoice.findUnique({
      where: { id: invoice.id },
      include: { user: true },
    });

    return { updatedInvoice, advanceRepayment, waterfallResult };
  });

  if (!paymentResult.updatedInvoice) {
    return NextResponse.json({ error: "Invalid invoice" }, { status: 400 });
  }

  const updatedInvoice = paymentResult.updatedInvoice;

  if (invoice.user.referredById) {
    await createReferralEarning({
      referrerId: invoice.user.referredById,
      referredUserId: invoice.user.id,
      invoiceId: invoice.id,
      invoiceAmount: Number(invoice.amount),
    });
  }

  // Process savings goals auto-deduction
  await processSavingsOnPayment(
    updatedInvoice.userId,
    Number(updatedInvoice.amount),
  );

  const waterfallResult = paymentResult.waterfallResult;
  if (waterfallResult.processed) {
    logger.info(
      `Waterfall payments processed: ${waterfallResult.distributions.length} distributions, lead share: ${waterfallResult.leadShare}`,
    );
  }

  if (paymentResult.advanceRepayment.processed) {
    console.log(
      `Advance repaid before waterfall: ${paymentResult.advanceRepayment.repaidAmount} USDC`,
    );
  }

  // Process auto-swap
  const { processAutoSwap } = await import("@/lib/auto-swap");
  await processAutoSwap(
    updatedInvoice.userId,
    Number(updatedInvoice.amount),
    updatedInvoice.user.email,
    updatedInvoice.user.name || undefined,
  );

  // Dispatch webhook for invoice.paid event
  await dispatchWebhooks(updatedInvoice.userId, "invoice.paid", {
    invoiceId: updatedInvoice.id,
    invoiceNumber: updatedInvoice.invoiceNumber,
    amount: Number(updatedInvoice.amount),
    currency: updatedInvoice.currency,
    clientEmail: updatedInvoice.clientEmail,
    clientName: updatedInvoice.clientName,
    paidAt: new Date().toISOString(),
  });

  // Update trust score (synchronous as per requirements)
  try {
    await updateUserTrustScore(updatedInvoice.userId);
  } catch (error) {
    logger.error({ err: error }, "Failed to update trust score after payment:");
    // Don't fail the payment if score update fails
  }

  return NextResponse.json({ success: true });
}
