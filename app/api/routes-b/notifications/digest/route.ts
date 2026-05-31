import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { parseDigestDate, getUserTimezone } from "../../_lib/dateUtils";

export const dynamic = "force-dynamic";

/**
 * GET /api/routes-b/notifications/digest?date=YYYY-MM-DD
 *
 * Returns a daily digest summary:
 * {
 *   period: { date: "2026-05-30", start: "...", end: "..." },
 *   totalsByType: { invoice_paid: 3, withdrawal_complete: 1, ... },
 *   top: [
 *     { id, type, title, message, createdAt, isRead }
 *   ],
 *   summary: { total: 5, unread: 2 }
 * }
 *
 * Defaults to today in user's timezone.
 * Single grouped query — no N+1.
 */

export async function GET(request: Request) {
  try {
    //  Auth 
    const authToken = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!authToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, timezone: true },
    });
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    //  Parse date 
    const { searchParams } = new URL(request.url);
    const dateParam = searchParams.get("date");

    const userTz = user.timezone || getUserTimezone(request);
    const dateResult = parseDigestDate(dateParam, userTz);

    if (!dateResult.ok) {
      return NextResponse.json(
        { error: dateResult.error, code: "INVALID_DATE" },
        { status: 400 }
      );
    }

    const { start, end, date } = dateResult;

    //  Single grouped query 
    // Uses raw query for efficient grouping — no N+1
    const [totalsRows, topNotifications, summaryRow] = await Promise.all([
      // Grouped counts by type
      prisma.$queryRaw<
        Array<{ type: string; count: bigint }>
      >`
        SELECT type, COUNT(*) as count
        FROM "Notification"
        WHERE "userId" = ${user.id}
          AND "createdAt" >= ${start}
          AND "createdAt" <= ${end}
        GROUP BY type
        ORDER BY count DESC
      `,

      // Top 10 most recent notifications
      prisma.notification.findMany({
        where: {
          userId: user.id,
          createdAt: { gte: start, lte: end },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          type: true,
          title: true,
          message: true,
          isRead: true,
          createdAt: true,
        },
      }),

      // Summary totals
      prisma.$queryRaw<
        Array<{ total: bigint; unread: bigint }>
      >`
        SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN "isRead" = false THEN 1 END) as unread
        FROM "Notification"
        WHERE "userId" = ${user.id}
          AND "createdAt" >= ${start}
          AND "createdAt" <= ${end}
      `,
    ]);

    // Build response 
    const totalsByType: Record<string, number> = {};
    for (const row of totalsRows) {
      totalsByType[row.type] = Number(row.count);
    }

    const summary = {
      total: Number(summaryRow[0]?.total ?? 0),
      unread: Number(summaryRow[0]?.unread ?? 0),
    };

    return NextResponse.json({
      period: {
        date,
        timezone: userTz,
        start: start.toISOString(),
        end: end.toISOString(),
      },
      totalsByType,
      top: topNotifications,
      summary,
    });
  } catch (error) {
    logger.error({ err: error }, "Notifications digest error");
    return NextResponse.json(
      { error: "Failed to generate digest" },
      { status: 500 }
    );
  }
}