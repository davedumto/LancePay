import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import {
  computePlatformFee,
  computeWithdrawalFee,
  fetchTaxTransactions,
  getTaxAuth,
  monthKeyUTC,
  parseYearParam,
  round2,
} from '@/app/api/routes-d/tax-reports/_shared'

export async function GET(request: NextRequest) {
  try {
    const auth = await getTaxAuth(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })
    if (!auth.user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const year = parseYearParam(request)
    if (!year) return NextResponse.json({ error: 'year is required (e.g. 2025)' }, { status: 400 })

    const { income, refunds, withdrawals } = await fetchTaxTransactions({ userId: auth.user.id, year })

    const incomeTotal = round2(income.reduce((sum, t: any) => sum + Number(t.amount), 0))
    const refundTotal = round2(refunds.reduce((sum, t: any) => sum + Number(t.amount), 0))
    const grossIncome = round2(incomeTotal - refundTotal)

    const platformFees = round2(income.reduce((sum, t: any) => sum + computePlatformFee(Number(t.amount)), 0))
    const withdrawalFees = round2(withdrawals.reduce((sum, t: any) => sum + computeWithdrawalFee(Number(t.amount)), 0))
    const totalFees = round2(platformFees + withdrawalFees)
    const netIncome = round2(grossIncome - totalFees)

    const invoiceIds = new Set<string>()
    const clients = new Set<string>()

    const monthlyMap = new Map<string, { income: number; invoices: Set<string> }>()
    const clientMap = new Map<string, { totalPaid: number; invoiceIds: Set<string> }>()

    for (const t of income as any[]) {
      const dt = (t.completedAt as Date | null) ?? new Date()
      const mk = monthKeyUTC(dt)
      const amt = Number(t.amount)
      const invNum = t.invoice?.invoiceNumber as string | undefined
      const invId = t.invoiceId as string | null | undefined
      const clientEmail = (t.invoice?.clientEmail as string | undefined) || 'unknown'

      if (invId) invoiceIds.add(invId)
      if (clientEmail && clientEmail !== 'unknown') clients.add(clientEmail.toLowerCase())

      if (!monthlyMap.has(mk)) monthlyMap.set(mk, { income: 0, invoices: new Set() })
      monthlyMap.get(mk)!.income = round2(monthlyMap.get(mk)!.income + amt)
      if (invNum) monthlyMap.get(mk)!.invoices.add(invNum)

      if (!clientMap.has(clientEmail)) clientMap.set(clientEmail, { totalPaid: 0, invoiceIds: new Set() })
      clientMap.get(clientEmail)!.totalPaid = round2(clientMap.get(clientEmail)!.totalPaid + amt)
      if (invNum) clientMap.get(clientEmail)!.invoiceIds.add(invNum)
    }

    // Apply refunds to totals only (we don't have per-invoice refund attribution yet)
    const monthlyBreakdown = Array.from(monthlyMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, v]) => ({ month, income: v.income, invoices: v.invoices.size }))

    const clientBreakdown = Array.from(clientMap.entries())
      .map(([clientEmail, v]) => ({
        clientEmail,
        totalPaid: v.totalPaid,
        invoiceCount: v.invoiceIds.size,
      }))
      .sort((a, b) => b.totalPaid - a.totalPaid)

    return NextResponse.json({
      year,
      summary: {
        totalIncome: grossIncome,
        totalFees,
        netIncome,
        invoiceCount: invoiceIds.size,
        clientCount: clients.size,
      },
      monthlyBreakdown,
      clientBreakdown,
    })
  } catch (error) {
    logger.error({ err: error }, 'Tax annual report error:')
    return NextResponse.json({ error: 'Failed to generate annual report' }, { status: 500 })
  }
}

