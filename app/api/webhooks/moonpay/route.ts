import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sendPaymentReceivedEmail } from '@/lib/email'
import { createReferralEarning } from '@/lib/referral'
import { processAutoSwap } from '@/lib/auto-swap'
import { dispatchWebhooks } from '@/lib/webhooks'
import { updateUserTrustScore } from '@/lib/reputation'
import { logger } from '@/lib/logger'
import { processAdvanceRepayment } from "@/lib/advance-repayment";
import { processWaterfallPayments } from "@/lib/waterfall";

export async function POST(request: NextRequest) {
  try {
    const event = await request.json();
    logger.info({ eventType: event.type }, "MoonPay webhook");

    if (
      event.type !== "transaction_completed" &&
      event.data?.status !== "completed"
    ) {
      return NextResponse.json({ received: true });
    }

    const invoiceNumber = event.data?.externalTransactionId;
    if (!invoiceNumber) return NextResponse.json({ received: true });

    const invoice = await prisma.invoice.findUnique({
      where: { invoiceNumber },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            referredById: true,
          },
        },
      },
    });

    if (!invoice || invoice.status === "paid")
      return NextResponse.json({ received: true });

    const settlementApplied = await prisma.$transaction(async (tx: any) => {
      const now = new Date()

      const updateResult = await tx.invoice.updateMany({
        where: { id: invoice.id, status: 'pending' },
        data: { status: 'paid', paidAt: now },
      })

      if (updateResult.count === 0) {
        return false
      }

      await tx.transaction.create({
        data: {
          userId: invoice.userId,
          type: 'payment',
          status: 'completed',
          amount: invoice.amount,
          currency: invoice.currency,
          invoiceId: invoice.id,
          completedAt: now,
        },
      })

      const advanceRepayment = await processAdvanceRepayment(
        tx,
        invoice.id,
        Number(invoice.amount)
      )

      await processWaterfallPayments(
        invoice.id,
        advanceRepayment.remainingAmount,
        tx
      )

      return true
    })

    if (!settlementApplied) {
      return NextResponse.json({ received: true })
    }

    if (invoice.user.referredById) {
      await createReferralEarning({
        referrerId: invoice.user.referredById,
        referredUserId: invoice.userId,
        invoiceId: invoice.id,
        invoiceAmount: Number(invoice.amount),
      });
    }

    const paymentAmount = Number(invoice.amount)

    // Process auto-swap if user has an active rule
    const autoSwapResult = await processAutoSwap(
      invoice.userId,
      paymentAmount,
      invoice.user.email,
      invoice.user.name || undefined,
    );

    if (autoSwapResult.triggered) {
      logger.info({
        userId: invoice.userId,
        swapAmount: autoSwapResult.swapAmount,
        remainingAmount: autoSwapResult.remainingAmount,
        bankAccountId: autoSwapResult.bankAccountId,
      }, "Auto-swap triggered for user");
      // Auto-swap notification is handled within processAutoSwap
    } else {
      // No auto-swap - send regular payment notification
      if (invoice.user.email) {
        await sendPaymentReceivedEmail({
          to: invoice.user.email,
          freelancerName: invoice.user.name || "Freelancer",
          clientName: invoice.clientName || "Client",
          invoiceNumber: invoice.invoiceNumber,
          amount: paymentAmount,
          currency: invoice.currency,
        });
      }
    }

    // Dispatch webhook for invoice.paid event
    await dispatchWebhooks(invoice.userId, "invoice.paid", {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      amount: paymentAmount,
      currency: invoice.currency,
      clientEmail: invoice.clientEmail,
      clientName: invoice.clientName,
      paidAt: new Date().toISOString(),
    });

    // Update trust score (synchronous as per requirements)
    try {
      await updateUserTrustScore(invoice.userId)
    } catch (error) {
      logger.error({ err: error, userId: invoice.userId }, 'Failed to update trust score after payment')
      // Don't fail the payment if score update fails
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    logger.error({ err: error }, "MoonPay webhook error");
    return NextResponse.json({ received: true });
  }
}
