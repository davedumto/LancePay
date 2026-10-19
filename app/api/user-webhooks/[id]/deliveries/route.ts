import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

/**
 * GET /api/user-webhooks/[id]/deliveries
 *
 * Lists delivery history for a specific webhook.
 *
 * Query params:
 *   - status (optional): filter deliveries by status ('delivered', 'failed', 'pending', etc.)
 *   - page   (optional): page number (default 1)
 *   - limit  (optional): page size (default 20, max 100)
 *
 * Visibility is restricted to the webhook owner or an admin.
 */
export async function GET(
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

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const pageParam = parseInt(searchParams.get("page") || "1", 10);
    const limitParam = parseInt(searchParams.get("limit") || "20", 10);

    const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, 100)
        : 20;

    const where: any = { webhookId: id };
    if (status) {
      where.status = status;
    }

    const [total, deliveries] = await Promise.all([
      prisma.webhookDelivery.count({ where }),
      prisma.webhookDelivery.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          webhookId: true,
          eventType: true,
          payload: true,
          status: true,
          attemptCount: true,
          lastAttemptAt: true,
          nextRetryAt: true,
          lastStatusCode: true,
          lastError: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    return NextResponse.json({
      deliveries,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    logger.error(
      { err: error },
      "GET /api/user-webhooks/[id]/deliveries error",
    );
    return NextResponse.json(
      { error: "Failed to list webhook deliveries" },
      { status: 500 },
    );
  }
}
