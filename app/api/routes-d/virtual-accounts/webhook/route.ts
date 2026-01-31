/**
 * Virtual Account Webhook Handler
 *
 * POST /api/routes-d/virtual-accounts/webhook
 *
 * Receives deposit notifications from payment providers (Korapay, Monnify, Paystack)
 * Verifies signature, processes deposit, credits user with USDC
 */

import { NextRequest, NextResponse } from "next/server";
import { getVirtualAccountProvider } from "@/lib/virtual-accounts/provider-factory";
import { processDeposit } from "@/lib/virtual-accounts/deposit-processor";

/**
 * POST /api/routes-d/virtual-accounts/webhook
 * Handle incoming deposit notifications from payment providers
 */
export async function POST(request: NextRequest) {
  try {
    // Get raw body as text for signature verification
    const body = await request.text();

    // Get headers for signature verification
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    // Extract signature from headers (provider-specific)
    const signature =
      headers["x-korapay-signature"] ||
      headers["monnify-signature"] ||
      headers["x-paystack-signature"] ||
      "";

    console.log("Webhook received:", {
      provider: process.env.VIRTUAL_ACCOUNT_PROVIDER,
      hasSignature: !!signature,
      bodyLength: body.length,
    });

    // Get provider and verify webhook
    const provider = getVirtualAccountProvider();
    const verificationResult = await provider.verifyWebhook(
      signature,
      body,
      headers,
    );

    if (!verificationResult.isValid) {
      console.error("Webhook verification failed:", verificationResult.error);
      return NextResponse.json(
        {
          error: "Invalid webhook signature",
          message: verificationResult.error,
        },
        { status: 401 },
      );
    }

    if (!verificationResult.payload) {
      console.error("Webhook payload missing after verification");
      return NextResponse.json(
        { error: "Invalid webhook payload" },
        { status: 400 },
      );
    }

    console.log("Webhook verified successfully:", {
      accountNumber: verificationResult.payload.accountNumber,
      amount: verificationResult.payload.amount,
      reference: verificationResult.payload.reference,
    });

    // Process the deposit
    const result = await processDeposit(verificationResult.payload);

    if (!result.success) {
      console.error("Deposit processing failed:", result);

      // For duplicate deposits, return 200 to prevent retries
      if (result.reason === "duplicate") {
        return NextResponse.json({
          received: true,
          message: "Deposit already processed",
          transactionId: result.transactionId,
        });
      }

      // For insufficient minimum, return 200 to prevent retries
      if (result.reason === "insufficient_minimum") {
        return NextResponse.json({
          received: true,
          message: "Deposit below minimum threshold",
          error: result.error,
        });
      }

      // For other errors, return 200 to acknowledge receipt
      // but log the error for manual intervention
      console.error("CRITICAL: Deposit processing failed:", {
        reason: result.reason,
        error: result.error,
        payload: verificationResult.payload,
      });

      return NextResponse.json({
        received: true,
        message: "Deposit received but processing failed",
        error: result.error,
        reason: result.reason,
      });
    }

    // Success!
    console.log("Deposit processed successfully:", {
      transactionId: result.transactionId,
      userId: result.userId,
      usdcCredited: result.usdcCredited,
      ngnReceived: result.ngnReceived,
      txHash: result.txHash,
    });

    return NextResponse.json({
      received: true,
      success: true,
      transactionId: result.transactionId,
      message: "Deposit processed successfully",
    });
  } catch (error) {
    console.error("Webhook handler error:", error);

    // Always return 200 to prevent webhook retries
    // Log errors for manual investigation
    return NextResponse.json({
      received: true,
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * GET /api/routes-d/virtual-accounts/webhook
 * Return basic info about the webhook endpoint (for testing)
 */
export async function GET() {
  return NextResponse.json({
    endpoint: "/api/routes-d/virtual-accounts/webhook",
    method: "POST",
    provider: process.env.VIRTUAL_ACCOUNT_PROVIDER || "not configured",
    message:
      "This endpoint receives deposit notifications from payment providers",
    headers: {
      korapay: "x-korapay-signature",
      monnify: "monnify-signature",
      paystack: "x-paystack-signature",
    },
  });
}
