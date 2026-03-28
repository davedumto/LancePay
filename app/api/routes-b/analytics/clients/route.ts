import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const authToken = request.headers
    .get("authorization")
    ?.replace("Bearer ", "");
  if (!authToken)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const claims = await verifyAuthToken(authToken);
  if (!claims)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
  });
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(
    50,
    Math.max(1, parseInt(url.searchParams.get("limit") || "10")),
  );

  const grouped = await prisma.invoice.groupBy({
    by: ["clientEmail", "clientName"],
    where: { userId: user.id },
    _count: { id: true },
    _sum: { amount: true },
    orderBy: { _sum: { amount: "desc" } },
    take: limit,
  });

  const clients = grouped.map((c: any) => ({
    clientEmail: c.clientEmail,
    clientName: c.clientName,
    totalInvoiced: Number(c._sum.amount ?? 0),
    invoiceCount: c._count.id,
  }));

  return NextResponse.json({ clients });
}
