import { NextRequest, NextResponse } from 'next/server'
import {
  computePlatformFee,
  computeWithdrawalFee,
  fetchTaxTransactions,
  getTaxAuth,
  parseYearParam,
  round2,
} from '@/app/api/routes-d/tax-reports/_shared'
import { TaxReportPDF, type TaxAnnualReport } from '@/lib/tax-pdf'
import { pdf } from '@react-pdf/renderer'
import React from 'react'
import { logger } from '@/lib/logger'

function csvEscape(value: string) {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

function toCsvRow(cols: string[]) {
  return cols.map(csvEscape).join(',')
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getTaxAuth(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })
    if (!auth.user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const year = parseYearParam(request)
    if (!year) return NextResponse.json({ error: 'year is required (e.g. 2025)' }, { status: 400 })

    const format = (request.nextUrl.searchParams.get('format') || 'json').toLowerCase()
    if (!['json', 'csv', 'pdf'].includes(format)) {
      return NextResponse.json({ error: 'format must be one of: pdf, csv, json' }, { status: 400 })
    }

    const { income, refunds, withdrawals } = await fetchTaxTransactions({ userId: auth.user.id, year })

    const incomeTotal = round2(income.reduce((sum, t: any) => sum + Number(t.amount), 0))
    const refundTotal = round2(refunds.reduce((sum, t: any) => sum + Number(t.amount), 0))
    const grossIncome = round2(incomeTotal - refundTotal)
    const platformFees = round2(income.reduce((sum, t: any) => sum + computePlatformFee(Number(t.amount)), 0))
    const withdrawalFees = round2(withdrawals.reduce((sum, t: any) => sum + computeWithdrawalFee(Number(t.amount)), 0))
    const totalFees = round2(platformFees + withdrawalFees)
    const netIncome = round2(grossIncome - totalFees)

    if (format === 'json') {
      return NextResponse.json({
        year,
        summary: {
          totalIncome: grossIncome,
          totalFees,
          netIncome,
          invoiceCount: new Set(income.map((t: any) => t.invoice?.invoiceNumber).filter(Boolean)).size,
          clientCount: new Set(income.map((t: any) => (t.invoice?.clientEmail || '').toLowerCase()).filter(Boolean)).size,
        },
        transactions: income.map((t: any) => ({
          date: (t.completedAt as Date).toISOString(),
          invoiceNumber: t.invoice?.invoiceNumber || '',
          clientEmail: t.invoice?.clientEmail || '',
          description: t.invoice?.description || '',
          amount: Number(t.amount),
          platformFee: computePlatformFee(Number(t.amount)),
          net: round2(Number(t.amount) - computePlatformFee(Number(t.amount))),
        })),
      })
    }

    if (format === 'csv') {
      const lines: string[] = []
      lines.push(toCsvRow(['Date', 'Invoice Number', 'Client', 'Description', 'Amount', 'Fees', 'Net']))

      for (const t of income as any[]) {
        const completedAt = t.completedAt as Date | null
        const dt = completedAt ? completedAt.toISOString().slice(0, 10) : 'UNKNOWN_DATE'
        const invNum = t.invoice?.invoiceNumber || ''
        const client = t.invoice?.clientEmail || ''
        const desc = t.invoice?.description || ''
        const amt = round2(Number(t.amount))
        const fee = computePlatformFee(amt)
        const net = round2(amt - fee)
        lines.push(toCsvRow([dt, invNum, client, desc, amt.toFixed(2), fee.toFixed(2), net.toFixed(2)]))
      }

      const csv = lines.join('\n')
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="lancepay-tax-${year}.csv"`,
        },
      })
    }

    // PDF
    const monthlyMap = new Map<string, { income: number; invoices: Set<string> }>()
    const clientMap = new Map<string, { totalPaid: number; invoiceIds: Set<string> }>()

    for (const t of income as any[]) {
      const dt = (t.completedAt as Date) || new Date()
      const mk = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`
      const amt = Number(t.amount)
      const invNum = t.invoice?.invoiceNumber as string | undefined
      const clientEmail = (t.invoice?.clientEmail as string | undefined) || 'unknown'

      if (!monthlyMap.has(mk)) monthlyMap.set(mk, { income: 0, invoices: new Set() })
      monthlyMap.get(mk)!.income = round2(monthlyMap.get(mk)!.income + amt)
      if (invNum) monthlyMap.get(mk)!.invoices.add(invNum)

      if (!clientMap.has(clientEmail)) clientMap.set(clientEmail, { totalPaid: 0, invoiceIds: new Set() })
      clientMap.get(clientEmail)!.totalPaid = round2(clientMap.get(clientEmail)!.totalPaid + amt)
      if (invNum) clientMap.get(clientEmail)!.invoiceIds.add(invNum)
    }

    const report: TaxAnnualReport = {
      year,
      freelancer: { name: auth.user.name || 'Freelancer', email: auth.user.email },
      summary: {
        totalIncome: grossIncome,
        totalFees,
        netIncome,
        invoiceCount: new Set(income.map((t: any) => t.invoice?.invoiceNumber).filter(Boolean)).size,
        clientCount: new Set(income.map((t: any) => (t.invoice?.clientEmail || '').toLowerCase()).filter(Boolean)).size,
      },
      monthlyBreakdown: Array.from(monthlyMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([month, v]) => ({ month, income: v.income, invoices: v.invoices.size })),
      clientBreakdown: Array.from(clientMap.entries())
        .map(([clientEmail, v]) => ({ clientEmail, totalPaid: v.totalPaid, invoiceCount: v.invoiceIds.size }))
        .sort((a, b) => b.totalPaid - a.totalPaid),
    }

    const buffer = await pdf((React.createElement(TaxReportPDF, { report }) as unknown) as any).toBuffer()
    return new NextResponse(buffer as any, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="lancepay-tax-${year}.pdf"`,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'Tax export error:')
    return NextResponse.json({ error: 'Failed to export tax report' }, { status: 500 })
  }
}

