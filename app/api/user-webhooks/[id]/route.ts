import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

/**
 * PATCH /api/user-webhooks/[id]
 *
 * Updates a webhook's configuration (targetUrl, subscribedEvents, isActive, description).
 * Does not allow updating signingSecret directly — secret rotation is handled exclusively
 * via the dedicated /api/user-webhooks/[id]/rotate-signing-secret endpoint.
 *
 * Only the webhook owner is authorized to update their webhook.
 */
export async function PATCH(
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

    if (webhook.userId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (
      body.signingSecret !== undefined ||
      body.previousSigningSecret !== undefined
    ) {
      return NextResponse.json(
        {
          error:
            "signingSecret cannot be modified directly; use /rotate-signing-secret",
        },
        { status: 400 },
      );
    }

    const dataToUpdate: {
      targetUrl?: string;
      subscribedEvents?: string[];
      isActive?: boolean;
      description?: string | null;
    } = {};

    if (body.targetUrl !== undefined) {
      if (typeof body.targetUrl !== "string" || !body.targetUrl.trim()) {
        return NextResponse.json(
          { error: "targetUrl must be a non-empty string" },
          { status: 400 },
        );
      }
      try {
        const parsed = new URL(body.targetUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return NextResponse.json(
            { error: "targetUrl must use http or https" },
            { status: 400 },
          );
        }
      } catch {
        return NextResponse.json(
          { error: "targetUrl must be a valid URL" },
          { status: 400 },
        );
      }
      if (body.targetUrl.length > 512) {
        return NextResponse.json(
          { error: "targetUrl cannot exceed 512 characters" },
          { status: 400 },
        );
      }
      dataToUpdate.targetUrl = body.targetUrl.trim();
    }

    if (body.subscribedEvents !== undefined) {
      if (
        !Array.isArray(body.subscribedEvents) ||
        body.subscribedEvents.some((e) => typeof e !== "string" || !e.trim())
      ) {
        return NextResponse.json(
          { error: "subscribedEvents must be an array of non-empty strings" },
          { status: 400 },
        );
      }
      dataToUpdate.subscribedEvents = body.subscribedEvents.map((e) =>
        e.trim(),
      );
    }

    if (body.isActive !== undefined) {
      if (typeof body.isActive !== "boolean") {
        return NextResponse.json(
          { error: "isActive must be a boolean" },
          { status: 400 },
        );
      }
      dataToUpdate.isActive = body.isActive;
    }

    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== "string") {
        return NextResponse.json(
          { error: "description must be a string or null" },
          { status: 400 },
        );
      }
      if (
        typeof body.description === "string" &&
        body.description.length > 100
      ) {
        return NextResponse.json(
          { error: "description cannot exceed 100 characters" },
          { status: 400 },
        );
      }
      dataToUpdate.description = body.description
        ? body.description.trim()
        : null;
    }

    const updatedWebhook = await prisma.userWebhook.update({
      where: { id },
      data: dataToUpdate,
    });

    logger.info({ userId: user.id, webhookId: id }, "User webhook updated");

    return NextResponse.json({ webhook: updatedWebhook }, { status: 200 });
  } catch (error) {
    logger.error({ err: error }, "PATCH /api/user-webhooks/[id] error");
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/user-webhooks/[id]
 *
 * Removes a webhook subscription.
 * Note on WebhookDelivery: The schema defines `onDelete: Cascade` on the `webhook`
 * relation in WebhookDelivery, so all delivery logs referencing this webhook are
 * automatically cascaded and deleted when the webhook is removed.
 *
 * Only the webhook owner is authorized to delete their webhook.
 */
export async function DELETE(
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

    if (webhook.userId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Cascade delete deliveries explicitly in a transaction to ensure clean cleanup
    // across all storage engines, in alignment with schema `onDelete: Cascade`.
    await prisma.$transaction([
      prisma.webhookDelivery.deleteMany({ where: { webhookId: id } }),
      prisma.userWebhook.delete({ where: { id } }),
    ]);

    logger.info(
      { userId: user.id, webhookId: id },
      "User webhook deleted with cascaded deliveries",
    );

    return NextResponse.json(
      { message: "Webhook deleted successfully" },
      { status: 200 },
    );
  } catch (error) {
    logger.error({ err: error }, "DELETE /api/user-webhooks/[id] error");
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
