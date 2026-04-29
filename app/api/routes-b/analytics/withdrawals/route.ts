import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { parseUtcDateRange } from "../../_lib/date-range";

const GROUP_BY_TO_DATE_TRUNC: Record<string, "day" | "week" | "month"> = {
  day: "day",
  week: "week",
  month: "month",
};

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers
      .get("authorization")
      ?.replace("Bearer ", "");
    if (!authToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const claims = await verifyAuthToken(authToken);
    if (!claims) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const parsedRange = parseUtcDateRange(url.searchParams);
    if (!parsedRange.ok) {
      return NextResponse.json(parsedRange.error, { status: 400 });
    }

    const requestedGroupBy = url.searchParams.get("groupBy") ?? "month";
    const groupBy = GROUP_BY_TO_DATE_TRUNC[requestedGroupBy];
    if (!groupBy) {
      return NextResponse.json(
        { error: "groupBy must be one of: month, week, day" },
        { status: 400 },
      );
    }

    const { from, toExclusive } = parsedRange.value;
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        bucket: Date;
        count: bigint;
        total_amount: unknown;
        avg_amount: unknown;
      }>
    >(
      `
      SELECT
        DATE_TRUNC('${groupBy}', "createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
        COUNT(*)::bigint AS count,
        COALESCE(SUM("amount"), 0) AS total_amount,
        COALESCE(AVG("amount"), 0) AS avg_amount
      FROM "Transaction"
      WHERE "userId" = $1
        AND "type" = 'withdrawal'
        AND "createdAt" >= $2
        AND "createdAt" < $3
      GROUP BY bucket
      ORDER BY bucket ASC
    `,
      user.id,
      from,
      toExclusive,
    );

    return NextResponse.json({
      groupBy,
      buckets: rows.map((row) => ({
        bucket: row.bucket.toISOString(),
        count: Number(row.count),
        totalAmount: Number(row.total_amount ?? 0),
        avgAmount: Number(row.avg_amount ?? 0),
      })),
    });
  } catch (error) {
    logger.error({ err: error }, "Routes B analytics withdrawals GET error");
    return NextResponse.json(
      { error: "Failed to get withdrawal stats" },
      { status: 500 },
    );
  }
}
