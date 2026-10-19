import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";
import crypto from "crypto";
import { z } from "zod";

export const ALLOWED_WEBHOOK_EVENTS = [
  "invoice.created",
  "invoice.paid",
  "invoice.overdue",
  "payment.received",
  "payout.initiated",
  "payout.completed",
  "payout.failed",
  "withdrawal.initiated",
  "withdrawal.completed",
  "withdrawal.failed",
] as const;

const createWebhookSchema = z.object({
  targetUrl: z.string().url("targetUrl must be a valid URL"),
  description: z.string().max(100).optional(),
  subscribedEvents: z
    .array(z.enum(ALLOWED_WEBHOOK_EVENTS))
    .min(1, "subscribedEvents must contain at least one event")
    .optional(),
  isActive: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const authToken = authHeader.replace("Bearer ", "");
    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const webhooks = await prisma.userWebhook.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        userId: true,
        targetUrl: true,
        description: true,
        isActive: true,
        subscribedEvents: true,
        status: true,
        lastTriggeredAt: true,
        consecutiveFailures: true,
        lastFailureAt: true,
        createdAt: true,
        // Notice signingSecret and previousSigningSecret are strictly EXCLUDED
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ webhooks });
  } catch (error: any) {
    logger.error({ err: error }, "GET /api/user-webhooks error");
    return NextResponse.json({ error: "Failed to list webhooks" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const authToken = authHeader.replace("Bearer ", "");
    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = createWebhookSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation error", details: parsed.error.issues },
        { status: 400 },
      );
    }

    const { targetUrl, description, subscribedEvents, isActive } = parsed.data;

    // Generate secure signing secret
    const signingSecret = `whsec_${crypto.randomBytes(32).toString("hex")}`;

    const webhook = await prisma.userWebhook.create({
      data: {
        userId: user.id,
        targetUrl,
        description: description ?? null,
        signingSecret,
        subscribedEvents: subscribedEvents ?? ["invoice.paid"],
        isActive: isActive ?? true,
        status: "ACTIVE",
      },
    });

    logger.info({ userId: user.id, webhookId: webhook.id }, "User webhook created");

    return NextResponse.json(
      {
        id: webhook.id,
        userId: webhook.userId,
        targetUrl: webhook.targetUrl,
        description: webhook.description,
        subscribedEvents: webhook.subscribedEvents,
        isActive: webhook.isActive,
        status: webhook.status,
        createdAt: webhook.createdAt,
        // Returned exactly once upon creation
        signingSecret,
      },
      { status: 201 },
    );
  } catch (error: any) {
    logger.error({ err: error }, "POST /api/user-webhooks error");
    return NextResponse.json({ error: "Failed to create webhook" }, { status: 500 });
  }
}
