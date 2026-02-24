import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { getUsdToNgnRate } from "@/lib/exchange-rate";
import { sendUSDCPayment } from "@/lib/stellar";
import { Keypair } from "@stellar/stellar-sdk";
import { logAuditEvent, extractRequestMetadata } from "@/lib/audit";
import { z } from "zod";

const VerifyPaymentSchema = z.object({
  paymentId: z.string().uuid(),
  action: z.enum(["confirm", "reject"]),
  notes: z.string().max(500).optional(),
});

export async function PATCH(request: NextRequest) {
  try {
    // Auth check
    const authToken = request.headers
      .get("authorization")
      ?.replace("Bearer ", "");
    if (!authToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    // Get user
    let user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      include: { wallet: true },
    });

    if (!user) {
      const email =
        (claims as { email?: string }).email || `${claims.userId}@privy.local`;
      user = await prisma.user.create({
        data: { privyId: claims.userId, email },
        include: { wallet: true },
      });
    }

    // Parse request
    const body = await request.json();
    const parsed = VerifyPaymentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Invalid request" },
        { status: 400 },
      );
    }

    const { paymentId, action, notes } = parsed.data;

    // Fetch manual payment with invoice
    const manualPayment = await prisma.manualPayment.findUnique({
      where: { id: paymentId },
      include: {
        invoice: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                name: true,
                wallet: { select: { address: true } },
              },
            },
          },
        },
      },
    });

    if (!manualPayment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    // Ownership verification
    if (manualPayment.invoice.userId !== user.id) {
      return NextResponse.json(
        { error: "Forbidden: You do not own this invoice" },
        { status: 403 },
      );
    }

    // Status check (idempotency)
    if (manualPayment.status !== "pending") {
      return NextResponse.json(
        { error: `Payment already ${manualPayment.status}` },
        { status: 409 },
      );
    }

    // Invoice status check
    if (manualPayment.invoice.status !== "pending") {
      return NextResponse.json(
        { error: `Invoice is already ${manualPayment.invoice.status}` },
        { status: 400 },
      );
    }

    // Handle REJECTION
    if (action === "reject") {
      await prisma.manualPayment.update({
        where: { id: paymentId },
        data: {
          status: "rejected",
          notes: notes || null,
          verifiedBy: user.id,
          verifiedAt: new Date(),
        },
      });

      return NextResponse.json({
        success: true,
        action: "rejected",
        message: "Payment rejected",
      });
    }

    // Handle CONFIRMATION

    // Wallet check
    if (!manualPayment.invoice.user.wallet) {
      return NextResponse.json(
        { error: "Freelancer wallet not found" },
        { status: 400 },
      );
    }

    // Get exchange rate (NGN → USD conversion)
    const rateResult = await getUsdToNgnRate();
    const exchangeRate = rateResult.rate;
    const ngnAmount = Number(manualPayment.amountPaid);
    const usdcAmount = ngnAmount / exchangeRate;

    // Round to nearest cent to avoid systematic truncation loss
    const usdcAmountRounded = Math.round(usdcAmount * 100) / 100;

    if (usdcAmountRounded <= 0) {
      return NextResponse.json(
        { error: "Converted USDC amount is too small" },
        { status: 400 },
      );
    }

    // Credit USDC via Stellar (using funding wallet)
    const fundingWalletSecret = process.env.STELLAR_FUNDING_WALLET_SECRET;
    if (!fundingWalletSecret) {
      return NextResponse.json(
        { error: "Funding wallet not configured" },
        { status: 500 },
      );
    }

    const fundingKeypair = Keypair.fromSecret(fundingWalletSecret);
    const fundingPublicKey = fundingKeypair.publicKey();
    const recipientAddress = manualPayment.invoice.user.wallet.address;

    // Execute Stellar transaction
    let txHash: string;
    try {
      txHash = await sendUSDCPayment(
        fundingPublicKey,
        fundingWalletSecret,
        recipientAddress,
        usdcAmountRounded.toString(),
      );
    } catch (stellarError: unknown) {
      console.error("Stellar payment failed:", stellarError);
      return NextResponse.json(
        {
          error: "Failed to credit USDC to wallet",
          details:
            stellarError instanceof Error
              ? stellarError.message
              : "Unknown Stellar error",
        },
        { status: 500 },
      );
    }

    // Database transaction: Update invoice, create transaction, update manual payment
    const now = new Date();

    const updatedInvoice = await prisma.$transaction(async (tx: any) => {
      // Update invoice
      await tx.invoice.update({
        where: { id: manualPayment.invoice.id },
        data: {
          status: "paid",
          paidAt: now,
        },
      });

      // Create transaction record
      await tx.transaction.create({
        data: {
          userId: manualPayment.invoice.userId,
          type: "incoming",
          status: "completed",
          amount: usdcAmountRounded,
          currency: "USD",
          ngnAmount,
          exchangeRate,
          invoiceId: manualPayment.invoice.id,
          txHash,
          completedAt: now,
        },
      });

      // Update manual payment
      await tx.manualPayment.update({
        where: { id: paymentId },
        data: {
          status: "verified",
          notes: notes || null,
          verifiedBy: user.id,
          verifiedAt: now,
        },
      });

      // Log audit event within transaction
      await logAuditEvent(
        manualPayment.invoice.id,
        "invoice.paid.manual",
        user.id,
        {
          ...extractRequestMetadata(request.headers),
          paymentMethod: "manual_bank_transfer",
          ngnAmount,
          usdcAmount: usdcAmountRounded,
          exchangeRate,
          txHash,
        },
        tx,
      );

      // Return the updated invoice with user data
      return tx.invoice.findUnique({
        where: { id: manualPayment.invoice.id },
        include: { user: true },
      });
    });

    if (!updatedInvoice) throw new Error("Invoice not found after update");

    // Send confirmation email to client
    if (updatedInvoice.clientEmail) {
      const { sendManualPaymentVerifiedEmail } = await import("@/lib/email");
      await sendManualPaymentVerifiedEmail({
        to: updatedInvoice.clientEmail,
        clientName: manualPayment.invoice.clientName || "Valued Client",
        invoiceNumber: updatedInvoice.invoiceNumber,
        amountPaid: ngnAmount,
        currency: manualPayment.currency,
      }).catch((err) => console.error("Email notification failed:", err));
    }

    return NextResponse.json({
      success: true,
      action: "confirmed",
      transaction: {
        txHash,
        usdcAmount: usdcAmountRounded,
        ngnAmount,
        exchangeRate,
      },
      invoice: {
        id: updatedInvoice.id,
        invoiceNumber: updatedInvoice.invoiceNumber,
        status: updatedInvoice.status,
      },
    });
  } catch (error) {
    console.error("Manual payment verification error:", error);
    return NextResponse.json(
      { error: "Failed to verify payment" },
      { status: 500 },
    );
  }
}
