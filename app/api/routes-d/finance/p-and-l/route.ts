import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  getOrCreateUserFromRequest,
  getPeriodDateRange,
  isValidPeriod,
  computeWithdrawalFee,
  round2,
  PLATFORM_FEE_RATE,
} from "@/app/api/routes-d/finance/_shared";
import { renderToBuffer } from "@react-pdf/renderer";
import { FinancialStatementPDF } from "./pdf-template";
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getOrCreateUserFromRequest(request);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { user } = auth;

    // Fetch branding settings
    const brandingSettings = await prisma.brandingSettings.findUnique({
      where: { userId: user.id },
    });

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams;
    const period = searchParams.get("period") || "current_month";
    const format = searchParams.get("format") || "json";

    // Validate period parameter
    if (!isValidPeriod(period)) {
      return NextResponse.json(
        {
          error:
            "Invalid period. Must be: current_month, last_month, current_quarter, or last_year",
        },
        { status: 400 },
      );
    }

    // Validate format parameter
    if (format !== "json" && format !== "pdf") {
      return NextResponse.json(
        { error: "Invalid format. Must be: json or pdf" },
        { status: 400 },
      );
    }

    // Get date range for period
    const dateRange = getPeriodDateRange(period);
    if (!dateRange) {
      return NextResponse.json(
        { error: "Failed to parse period" },
        { status: 400 },
      );
    }

    const { start, end, label } = dateRange;

    // 1. Fetch Income (Paid Invoices / Completed Incoming Transactions)
    const incomeTransactions = await prisma.transaction.findMany({
      where: {
        userId: user.id,
        status: "completed",
        type: { in: ["incoming", "payment"] },
        // use half-open interval [start, end) so period boundaries follow calendar definitions
        completedAt: { gte: start, lt: end },
      },
      include: {
        invoice: {
          select: {
            invoiceNumber: true,
            clientEmail: true,
            clientName: true,
            description: true,
            amount: true,
          },
        },
      },
      orderBy: { completedAt: "asc" },
    });

    // 2. Fetch Withdrawals (for operating expenses calculation)
    const withdrawalTransactions = await prisma.transaction.findMany({
      where: {
        userId: user.id,
        status: "completed",
        type: "withdrawal",
        // end is exclusive to avoid including the very start of the next calendar period
        completedAt: { gte: start, lt: end },
      },
    });

    // 3. Fetch Expected Revenue (Pending/Escrowed Invoices)
    const pendingInvoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        OR: [
          { status: "pending" },
          { escrowStatus: { in: ["pending", "funded"] } },
        ],
        // treat end as exclusive for consistency with transaction queries
        createdAt: { gte: start, lt: end },
      },
    });

    // 4. Fetch Logged Expenses (same period)
    const loggedExpenses = await prisma.expense.findMany({
      where: {
        userId: user.id,
        expenseDate: { gte: start, lt: end },
      },
      orderBy: { expenseDate: "asc" },
      select: {
        amount: true,
        category: true,
        currency: true,
      },
    });

    // Calculations
    const grossRevenue = round2(
      incomeTransactions.reduce(
        (sum: number, t: any) => sum + Number(t.amount),
        0,
      ),
    );

    // Platform Fees: percentage of Gross Revenue
    const platformFees = round2(grossRevenue * PLATFORM_FEE_RATE);

    // Operating Expenses: Withdrawal Fees
    const withdrawalFees = round2(
      withdrawalTransactions.reduce(
        (sum: number, t: any) => sum + computeWithdrawalFee(Number(t.amount)),
        0,
      ),
    );

    const loggedExpenseTotal = round2(
      loggedExpenses.reduce((sum: number, e: any) => sum + Number(e.amount), 0),
    );

    const expenseByCategoryMap = new Map<string, number>();
    for (const expense of loggedExpenses) {
      expenseByCategoryMap.set(
        expense.category,
        (expenseByCategoryMap.get(expense.category) || 0) + Number(expense.amount),
      );
    }
    const expenseBreakdown = Array.from(expenseByCategoryMap.entries())
      .map(([category, amount]) => ({ category, amount: round2(amount) }))
      .sort((a, b) => b.amount - a.amount);

    const totalExpenses = round2(withdrawalFees + loggedExpenseTotal);

    // Net Profit
    const netProfit = round2(grossRevenue - platformFees - totalExpenses);

    // Expected Revenue from pending invoices
    const expectedRevenue = round2(
      pendingInvoices.reduce(
        (sum: number, inv: any) => sum + Number(inv.amount),
        0,
      ),
    );

    // Top Clients
    const clientMap = new Map<string, number>();
    for (const t of incomeTransactions) {
      const name =
        t.invoice?.clientName || t.invoice?.clientEmail || "Unknown Client";
      clientMap.set(name, (clientMap.get(name) || 0) + Number(t.amount));
    }
    const topClients = Array.from(clientMap.entries())
      .map(([name, revenue]) => ({ name, revenue: round2(revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const responseData = {
      period: label,
      summary: {
        totalIncome: grossRevenue,
        platformFees,
        withdrawalFees,
        loggedExpenses: loggedExpenseTotal,
        totalExpenses,
        netProfit,
        expectedRevenue,
      },
      expenses: {
        count: loggedExpenses.length,
        byCategory: expenseBreakdown,
      },
      topClients,
      currency: incomeTransactions[0]?.currency || "USDC",
    };

    if (format === "pdf") {
      const buffer = await renderToBuffer(
        FinancialStatementPDF({
          data: {
            ...responseData,
            generatedAt: new Date().toLocaleDateString(),
          },
          branding: brandingSettings || undefined,
        }),
      );

      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="PL_Statement_${label.replace(/\s/g, "_")}.pdf"`,
        },
      });
    }

    return NextResponse.json(responseData);
  } catch (error) {
    logger.error({ err: error }, "P&L Report Error:");
    return NextResponse.json(
      { error: "Failed to generate P&L report" },
      { status: 500 },
    );
  }
}
