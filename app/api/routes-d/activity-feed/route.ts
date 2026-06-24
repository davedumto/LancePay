import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

// ── GET /api/routes-d/activity-feed — fetch real-time activity feed ──
//
// Returns a paginated feed of audit events for invoices owned by the
// authenticated user. Supports filtering by event type and date range.

type AuditEventDelegate = {
  findMany: (
    args: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;
  count: (args: Record<string, unknown>) => Promise<number>;
};

function getAuditEventDelegate(): AuditEventDelegate {
  return (prisma as unknown as { auditEvent: AuditEventDelegate }).auditEvent;
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  const claims = await verifyAuthToken(authToken || "");

  if (!claims) {
    return null;
  }

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  });
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);

    // Parse pagination
    const limitParam = searchParams.get("limit");
    const skipParam = searchParams.get("skip");

    const limit = limitParam
      ? Math.min(Math.max(parseInt(limitParam) || 20, 1), 100)
      : 20;
    const skip = skipParam ? Math.max(parseInt(skipParam) || 0, 0) : 0;

    if (isNaN(limit) || isNaN(skip)) {
      return NextResponse.json(
        { error: "limit and skip must be valid numbers" },
        { status: 400 },
      );
    }

    // Parse filters
    const eventType = searchParams.get("eventType");
    const since = searchParams.get("since");
    const until = searchParams.get("until");

    const dateFilter: Record<string, unknown> = {};
    if (since) {
      const d = new Date(since);
      if (!isNaN(d.getTime())) dateFilter.gte = d;
    }
    if (until) {
      const d = new Date(until);
      if (!isNaN(d.getTime())) dateFilter.lte = d;
    }

    // Build where clause
    const where: Record<string, unknown> = {
      invoice: {
        userId: user.id,
      },
    };

    if (eventType) {
      where.eventType = eventType;
    }

    if (Object.keys(dateFilter).length > 0) {
      where.createdAt = dateFilter;
    }

    // Fetch total count
    const total = await getAuditEventDelegate().count({ where });

    // Fetch events
    const events = await getAuditEventDelegate().findMany({
      where,
      select: {
        id: true,
        invoiceId: true,
        eventType: true,
        actorId: true,
        metadata: true,
        signature: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip,
    });

    // Fetch actor details for non-null actorIds
    const actorIds = [
      ...new Set(
        events
          .map((e) => (e as { actorId: string | null }).actorId)
          .filter(Boolean),
      ),
    ];
    const actors = actorIds.length
      ? await prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, email: true, name: true },
        })
      : [];

    const actorMap = new Map(actors.map((a) => [a.id, a]));

    return NextResponse.json({
      feed: events.map((event) => {
        const evt = event as {
          id: string;
          invoiceId: string;
          eventType: string;
          actorId: string | null;
          metadata: unknown;
          signature: string;
          createdAt: Date;
        };
        const actor = evt.actorId ? actorMap.get(evt.actorId) : null;

        return {
          id: evt.id,
          invoiceId: evt.invoiceId,
          eventType: evt.eventType,
          actor: actor
            ? {
                id: actor.id,
                email: actor.email,
                name: actor.name ?? null,
              }
            : null,
          metadata: evt.metadata ?? null,
          signature: evt.signature,
          createdAt: evt.createdAt,
        };
      }),
      pagination: {
        total,
        limit,
        skip,
        returned: events.length,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "GET /api/routes-d/activity-feed error");
    return NextResponse.json(
      { error: "Failed to fetch activity feed" },
      { status: 500 },
    );
  }
}
