import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { createCsvStream } from "../../_lib/csv-stream";

function isValidIsoDate(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime());
}

type TransactionRow = {
  id: string;
  type: string;
  status: string;
  amount: unknown;
  currency: string;
  createdAt: Date;
};

export async function GET(request: NextRequest) {
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  const claims = await verifyAuthToken(authToken || "");
  if (!claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!from || !to) {
    return NextResponse.json(
      { error: "from and to query parameters are required" },
      { status: 400 }
    );
  }

  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return NextResponse.json(
      { error: "from and to must be valid ISO dates" },
      { status: 400 }
    );
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);

  const where = {
    userId: user.id,
    createdAt: { gte: fromDate, lte: toDate },
  };

  const stream = createCsvStream<TransactionRow>(
    [
      { header: "id", value: (row) => row.id },
      { header: "type", value: (row) => row.type },
      { header: "status", value: (row) => row.status },
      { header: "amount", value: (row) => Number(row.amount).toFixed(2) },
      { header: "currency", value: (row) => row.currency },
      { header: "createdAt", value: (row) => row.createdAt },
    ],
    (cursor, batchSize) =>
      prisma.transaction.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: batchSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          type: true,
          status: true,
          amount: true,
          currency: true,
          createdAt: true,
        },
      }),
  );

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="transactions.csv"',
    },
  });
}
