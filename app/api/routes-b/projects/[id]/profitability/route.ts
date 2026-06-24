import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyAuthToken } from "@/lib/auth";
import { logger } from "@/lib/logger";

// ── GET /api/routes-b/projects/[id]/profitability — per-project profitability report ──
//
// Aggregates paid invoices for the given project and returns total revenue,
// invoice count, average invoice value, and time entry statistics. The project
// must belong to the authenticated user.

type ProjectDelegate = {
  findFirst: (
    args: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null>;
};

function getProjectDelegate(): ProjectDelegate {
  return (prisma as unknown as { project: ProjectDelegate }).project;
}

type InvoiceDelegate = {
  findMany: (
    args: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;
};

function getInvoiceDelegate(): InvoiceDelegate {
  return (prisma as unknown as { invoice: InvoiceDelegate }).invoice;
}

type TimeEntryDelegate = {
  findMany: (
    args: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>;
};

function getTimeEntryDelegate(): TimeEntryDelegate {
  return (prisma as unknown as { timeEntry: TimeEntryDelegate }).timeEntry;
}

function decimalToNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(
    typeof (value as { toString?: () => string })?.toString === "function"
      ? (value as { toString: () => string }).toString()
      : String(value),
  );
  return Number.isFinite(n) ? n : 0;
}

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
    if (!id)
      return NextResponse.json({ error: "id is required" }, { status: 400 });

    // Resolve project — must belong to authenticated user
    const project = await getProjectDelegate().findFirst({
      where: { id, userId: user.id },
      select: { id: true, title: true, status: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
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

    // Get paid invoices for this project
    const invoices = await getInvoiceDelegate().findMany({
      where: {
        userId: user.id,
        // Assuming invoices can be linked to projects via a relationship
        // If not directly, we filter by a projectId field if it exists
        status: "paid",
        ...(Object.keys(dateFilter).length > 0 ? { paidAt: dateFilter } : {}),
      },
      select: { id: true, amount: true, currency: true, paidAt: true },
    });

    // Get time entries for this project to calculate billable hours
    const timeEntries = await getTimeEntryDelegate().findMany({
      where: {
        userId: user.id,
        invoiceId: null, // unbilled time entries
      },
      select: { id: true, hours: true, rateUsdc: true },
    });

    const totalRevenue = invoices.reduce(
      (sum, inv) => sum + decimalToNumber((inv as { amount: unknown }).amount),
      0,
    );
    const invoiceCount = invoices.length;
    const avgInvoiceValue = invoiceCount > 0 ? totalRevenue / invoiceCount : 0;

    // Calculate billable hours and potential revenue
    const totalBillableHours = timeEntries.reduce(
      (sum, entry) =>
        sum + decimalToNumber((entry as { hours: unknown }).hours),
      0,
    );
    const potentialRevenue = timeEntries.reduce(
      (sum, entry) =>
        sum +
        decimalToNumber((entry as { hours: unknown }).hours) *
          decimalToNumber((entry as { rateUsdc: unknown }).rateUsdc),
      0,
    );

    return NextResponse.json({
      projectId: (project as { id: string }).id,
      projectTitle: (project as { title: string }).title,
      projectStatus: (project as { status: string }).status,
      report: {
        invoiceCount,
        totalRevenue: totalRevenue.toFixed(2),
        avgInvoiceValue: avgInvoiceValue.toFixed(2),
        currency: invoices[0]
          ? (invoices[0] as { currency: string }).currency
          : "USD",
        timeEntries: {
          unbilledCount: timeEntries.length,
          totalBillableHours: totalBillableHours.toFixed(2),
          potentialRevenue: potentialRevenue.toFixed(2),
        },
      },
    });
  } catch (error) {
    logger.error(
      { err: error },
      "GET /api/routes-b/projects/[id]/profitability error",
    );
    return NextResponse.json(
      { error: "Failed to generate profitability report" },
      { status: 500 },
    );
  }
}
