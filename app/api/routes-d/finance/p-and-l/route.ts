import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import {
  getOrCreateUserFromRequest,
  getPeriodDateRange,
  isValidPeriod,
  computePlatformFee,
  computeWithdrawalFee,
  round2,
} from '@/app/api/routes-d/finance/_shared'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { FinancePDF } from '@/lib/finance-pdf'

export async function GET(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getOrCreateUserFromRequest(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const { user } = auth

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams
    const period = searchParams.get('period')
    const format = searchParams.get('format') || 'json'

    // Validate period parameter
    if (!period) {
      return NextResponse.json(
        { error: 'period parameter is required (current_month, last_month, current_quarter, last_year)' },
        { status: 400 }
      )
    }

    if (!isValidPeriod(period)) {
      return NextResponse.json(
        { error: 'Invalid period. Must be: current_month, last_month, current_quarter, or last_year' },
        { status: 400 }
      )
    }

    // Validate format parameter
    if (format !== 'json' && format !== 'pdf') {
      return NextResponse.json({ error: 'Invalid format. Must be: json or pdf' }, { status: 400 })
    }

    // Get date range for period
    const dateRange = getPeriodDateRange(period)
    if (!dateRange) {
      return NextResponse.json({ error: 'Failed to parse period' }, { status: 400 })
    }

    // Fetch income transactions (incoming payments from invoices + MoonPay top-ups)
    const incomeTransactions = await prisma.transaction.findMany({
      where: {
        userId: user.id,
        status: 'completed',
        type: { in: ['incoming', 'payment'] },
        completedAt: {
          gte: dateRange.start,
          lt: dateRange.end,
        },
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
      orderBy: { completedAt: 'asc' },
    })

    // Fetch refund transactions (subtract from gross income)
    const refundTransactions = await prisma.transaction.findMany({
      where: {
        userId: user.id,
        status: 'completed',
        type: 'refund',
        completedAt: {
          gte: dateRange.start,
          lt: dateRange.end,
        },
      },
      orderBy: { completedAt: 'asc' },
    })

    // Fetch withdrawal transactions (operating expenses)
    const withdrawalTransactions = await prisma.transaction.findMany({
      where: {
        userId: user.id,
        status: 'completed',
        type: 'withdrawal',
        completedAt: {
          gte: dateRange.start,
          lt: dateRange.end,
        },
      },
      include: {
        bankAccount: {
          select: {
            bankName: true,
            accountNumber: true,
          },
        },
      },
      orderBy: { completedAt: 'asc' },
    })

    // Calculate gross income
    const totalIncome = round2(
      incomeTransactions.reduce((sum, t) => sum + Number(t.amount), 0)
    )
    const totalRefunds = round2(
      refundTransactions.reduce((sum, t) => sum + Number(t.amount), 0)
    )
    const grossIncome = round2(totalIncome - totalRefunds)

    // Calculate platform fees (0.5% of each income transaction)
    const platformFees = round2(
      incomeTransactions.reduce((sum, t) => sum + computePlatformFee(Number(t.amount)), 0)
    )

    // Calculate withdrawal fees (0.5% of each withdrawal)
    const withdrawalFees = round2(
      withdrawalTransactions.reduce((sum, t) => sum + computeWithdrawalFee(Number(t.amount)), 0)
    )

    // Calculate operating expenses (total withdrawal amounts)
    const operatingExpenses = round2(
      withdrawalTransactions.reduce((sum, t) => sum + Number(t.amount), 0)
    )

    // Calculate net profit
    const netProfit = round2(grossIncome - platformFees - withdrawalFees - operatingExpenses)

    // Analyze top clients
    const clientMap = new Map<
      string,
      { name: string; email: string; revenue: number; invoiceCount: number }
    >()

    for (const transaction of incomeTransactions) {
      if (transaction.invoice) {
        const clientEmail = transaction.invoice.clientEmail.toLowerCase()
        const clientName = transaction.invoice.clientName || 'Unknown Client'
        const amount = Number(transaction.amount)

        if (!clientMap.has(clientEmail)) {
          clientMap.set(clientEmail, {
            name: clientName,
            email: clientEmail,
            revenue: 0,
            invoiceCount: 0,
          })
        }

        const client = clientMap.get(clientEmail)!
        client.revenue = round2(client.revenue + amount)
        client.invoiceCount++
      }
    }

    // Sort clients by revenue and get top 5
    const topClients = Array.from(clientMap.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)

    // Prepare response data
    const responseData = {
      period: dateRange.label,
      dateRange: {
        start: dateRange.start.toISOString().split('T')[0],
        end: new Date(dateRange.end.getTime() - 1).toISOString().split('T')[0], // Subtract 1ms to get last day of period
      },
      summary: {
        totalIncome: grossIncome,
        platformFees,
        withdrawalFees,
        operatingExpenses,
        netProfit,
      },
      topClients,
      currency: 'USD',
    }

    // Return JSON or PDF based on format parameter
    if (format === 'pdf') {
      // Get user info for PDF
      const userInfo = await prisma.user.findUnique({
        where: { id: user.id },
        select: { name: true, email: true },
      })

      const pdfData = {
        ...responseData,
        freelancer: {
          name: userInfo?.name || 'Freelancer',
          email: userInfo?.email || user.email,
        },
      }

      const pdfBuffer = await renderToBuffer(React.createElement(FinancePDF, { report: pdfData }))

      return new NextResponse(pdfBuffer, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="P&L-${period}-${Date.now()}.pdf"`,
        },
      })
    }

    return NextResponse.json(responseData)
  } catch (error) {
    console.error('P&L report error:', error)
    return NextResponse.json(
      { error: 'Failed to generate P&L report' },
      { status: 500 }
    )
  }
}
