import { withRequestId } from '../../_lib/with-request-id'
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { toInt, BadRequest } from "../_lib/coerce";
import { withCompression } from "../_lib/with-compression";

async function GETHandler(request: NextRequest) {
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
  const includeOthers = url.searchParams.get("includeOthers") === "true";
  let top: number
  try {
    top = toInt(url.searchParams.get("top"), "top", { default: 10, min: 1, max: 50 })
  } catch (err) {
    if (err instanceof BadRequest) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  // Single SQL query using CTE to get top N and others bucket
  const results = await prisma.$queryRaw<any[]>`
    WITH client_stats AS (
      SELECT 
        "clientEmail", 
        "clientName", 
        SUM(amount) as "totalPaid", 
        COUNT(id) as "invoiceCount", 
        MAX("paidAt") as "lastPaymentAt",
        ROW_NUMBER() OVER (
          ORDER BY SUM(amount) DESC, COUNT(id) DESC, MAX("paidAt") DESC
        ) as rank
      FROM "Invoice"
      WHERE "userId" = ${user.id} AND "paidAt" IS NOT NULL
      GROUP BY "clientEmail", "clientName"
    ),
    top_clients AS (
      SELECT * FROM client_stats WHERE rank <= ${top}
    ),
    others_bucket AS (
      SELECT 
        'others' as "clientEmail", 
        'Others' as "clientName", 
        SUM("totalPaid") as "totalPaid", 
        SUM("invoiceCount") as "invoiceCount", 
        MAX("lastPaymentAt") as "lastPaymentAt",
        ${top} + 1 as rank
      FROM client_stats 
      WHERE rank > ${top}
    )
    SELECT * FROM top_clients
    ${includeOthers ? prisma.sql`UNION ALL SELECT * FROM others_bucket WHERE "totalPaid" IS NOT NULL` : prisma.sql``}
    ORDER BY rank ASC
  `;

  const clients = results.map((c: any) => {
    const totalPaid = Number(c.totalPaid ?? 0);
    const invoiceCount = Number(c.invoiceCount ?? 0);
    const lastPaymentAt = c.lastPaymentAt ? new Date(c.lastPaymentAt) : null;

    return {
      clientEmail: c.clientEmail,
      clientName: c.clientName,
      totalPaid,
      lastPaymentAt,
      invoiceCount,
      isOthers: c.clientEmail === 'others'
    };
  });

  return withCompression(request, NextResponse.json({ clients }));
}


export const GET = withRequestId(GETHandler)
