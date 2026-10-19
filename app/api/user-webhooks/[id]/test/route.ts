import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { computeWebhookSignature } from "@/lib/webhook-signature";

/**
 * POST /api/user-webhooks/[id]/test
 *
 * Sends a synthetic test event to the webhook's configured targetUrl to verify
 * endpoint reachability and signature validation without waiting for real business events.
 *
 * Requirements:
 * - Signs the test payload with the webhook's real signingSecret.
 * - Records the delivery attempt as a WebhookDelivery with eventType 'test.ping'.
 * - Returns raw response status and roundtrip latency directly to the caller.
 * - Restricts access to the webhook owner or an admin.
 */
export async function POST(
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
    });
    if (!user)
      return NextResponse.json({ error: "User not found" }, { status: 404 });

    const { id } = await params;
    const webhook = await prisma.userWebhook.findUnique({ where: { id } });
    if (!webhook)
      return NextResponse.json({ error: "Webhook not found" }, { status: 404 });

    if (webhook.userId !== user.id && user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const testPayload = JSON.stringify({
      id: `evt_test_${crypto.randomUUID()}`,
      eventType: "test.ping",
      webhookId: id,
      timestamp: new Date().toISOString(),
      message:
        "Synthetic test event to verify endpoint reachability and signature validation.",
    });

    const signature = computeWebhookSignature(
      testPayload,
      webhook.signingSecret,
    );

    const startTime = Date.now();
    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let deliveryError: string | null = null;
    let isSuccess = false;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(webhook.targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "User-Agent": "LancePay-Webhook-Test/1.0",
        },
        body: testPayload,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      responseStatus = res.status;
      responseBody = await res.text().catch(() => "");
      isSuccess = res.ok;
    } catch (err: any) {
      deliveryError = err?.message || "Failed to reach webhook target URL";
    }

    const latencyMs = Date.now() - startTime;

    const delivery = await prisma.webhookDelivery.create({
      data: {
        webhookId: id,
        eventType: "test.ping",
        payload: testPayload,
        status: isSuccess ? "delivered" : "failed",
        attemptCount: 1,
        lastAttemptAt: new Date(),
        lastStatusCode: responseStatus,
        lastError: deliveryError,
      },
    });

    logger.info(
      {
        userId: user.id,
        webhookId: id,
        deliveryId: delivery.id,
        statusCode: responseStatus,
        latencyMs,
      },
      "Webhook reachability test fired",
    );

    return NextResponse.json(
      {
        success: isSuccess,
        deliveryId: delivery.id,
        eventType: "test.ping",
        targetUrl: webhook.targetUrl,
        statusCode: responseStatus,
        latencyMs,
        responseBody,
        error: deliveryError,
      },
      { status: 200 },
    );
  } catch (error) {
    logger.error({ err: error }, "POST /api/user-webhooks/[id]/test error");
    return NextResponse.json(
      { error: "Failed to execute webhook test" },
      { status: 500 },
    );
  }
}
