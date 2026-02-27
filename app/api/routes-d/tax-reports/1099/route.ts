import { NextRequest, NextResponse } from 'next/server'
import { fetchTaxTransactions, getTaxAuth, parseYearParam, round2 } from '@/app/api/routes-d/tax-reports/_shared'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const auth = await getTaxAuth(request)
    if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 401 })
    if (!auth.user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const year = parseYearParam(request)
    if (!year) return NextResponse.json({ error: 'year is required (e.g. 2025)' }, { status: 400 })

    const clientEmail = request.nextUrl.searchParams.get('clientEmail')
    if (!clientEmail) return NextResponse.json({ error: 'clientEmail is required' }, { status: 400 })

    const { income } = await fetchTaxTransactions({ userId: auth.user.id, year })

    const filtered = (income as any[]).filter((t) => (t.invoice?.clientEmail || '').toLowerCase() === clientEmail.toLowerCase())

    const totalPaid = round2(filtered.reduce((sum, t) => sum + Number(t.amount), 0))

    const invoices = filtered
      .filter((t) => t.invoice?.invoiceNumber)
      .map((t) => ({
        invoiceNumber: t.invoice.invoiceNumber,
        date: ((t.completedAt as Date) || new Date()).toISOString().slice(0, 10),
        amount: round2(Number(t.amount)),
      }))

    return NextResponse.json({
      year,
      freelancer: { name: auth.user.name || 'Freelancer', email: auth.user.email },
      client: { email: clientEmail, name: '' },
      totalPaid,
      invoices,
    })
  } catch (error) {
    logger.error({ err: error }, 'Tax 1099 error:')
    return NextResponse.json({ error: 'Failed to generate 1099 report' }, { status: 500 })
  }
}

