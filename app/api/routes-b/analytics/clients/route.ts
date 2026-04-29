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
    where: { userId: user.id, paidAt: { not: null } },
    _count: { id: true },
    _sum: { amount: true },
    _max: { paidAt: true },
    _min: { createdAt: true },
    orderBy: { _sum: { amount: "desc" } },
    take: limit,
  });

  const clients = grouped.map((c: any) => {
    const totalPaid = Number(c._sum.amount ?? 0);
    const invoiceCount = c._count.id;
    const firstInvoiceDate = c._min.createdAt ? new Date(c._min.createdAt) : null;
    const lastPaymentAt = c._max.paidAt ? new Date(c._max.paidAt) : null;

    let activeMonths = 0;
    if (firstInvoiceDate && lastPaymentAt) {
      const diffTime = Math.abs(lastPaymentAt.getTime() - firstInvoiceDate.getTime());
      activeMonths = Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 30));
    }

    const avgMonthlyPaid = activeMonths > 0 ? totalPaid / activeMonths : 0;
    const projectedAnnual = activeMonths >= 3 ? avgMonthlyPaid * 12 : undefined;

    return {
      clientEmail: c.clientEmail,
      clientName: c.clientName,
      totalPaid,
      activeMonths,
      avgMonthlyPaid,
      lastPaymentAt,
      projectedAnnual,
      invoiceCount,
    };
  });

  return NextResponse.json({ clients });
}
