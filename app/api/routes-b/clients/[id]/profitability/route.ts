import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-b/clients/[id]/profitability — per-client profitability report ──
//
// Aggregates paid invoices for the given client (identified by clientEmail on
// Invoice rows) and returns total revenue, invoice count, and average invoice
// value. The client must belong to the authenticated user.

type InvoiceDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
}

function getInvoiceDelegate(): InvoiceDelegate {
  return (prisma as unknown as { invoice: InvoiceDelegate }).invoice
}

type ContactDelegate = {
  findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

function getContactDelegate(): ContactDelegate {
  return (prisma as unknown as { contact: ContactDelegate }).contact
}

function decimalToNumber(value: unknown): number {
  if (value === null || value === undefined) return 0
  const n = Number(
    typeof (value as { toString?: () => string })?.toString === 'function'
      ? (value as { toString: () => string }).toString()
      : String(value),
  )
  return Number.isFinite(n) ? n : 0
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

    // Resolve client — the Contact row for this user with this id.
    const contact = await getContactDelegate().findFirst({
      where: { id, userId: user.id },
      select: { id: true, name: true, email: true },
    })

    if (!contact) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    const { searchParams } = new URL(request.url)
    const since = searchParams.get('since')
    const until = searchParams.get('until')
    const dateFilter: Record<string, unknown> = {}
    if (since) {
      const d = new Date(since)
      if (!isNaN(d.getTime())) dateFilter.gte = d
    }
    if (until) {
      const d = new Date(until)
      if (!isNaN(d.getTime())) dateFilter.lte = d
    }

    const invoices = await getInvoiceDelegate().findMany({
      where: {
        userId: user.id,
        clientEmail: (contact as { email: string }).email,
        status: 'paid',
        ...(Object.keys(dateFilter).length > 0 ? { paidAt: dateFilter } : {}),
      },
      select: { id: true, amount: true, currency: true, paidAt: true },
    })

    const totalRevenue = invoices.reduce(
      (sum, inv) => sum + decimalToNumber((inv as { amount: unknown }).amount),
      0,
    )
    const invoiceCount = invoices.length
    const avgInvoiceValue = invoiceCount > 0 ? totalRevenue / invoiceCount : 0

    return NextResponse.json({
      clientId: (contact as { id: string }).id,
      clientName: (contact as { name: string }).name,
      clientEmail: (contact as { email: string }).email,
      report: {
        invoiceCount,
        totalRevenue: totalRevenue.toFixed(2),
        avgInvoiceValue: avgInvoiceValue.toFixed(2),
        currency: invoices[0]
          ? (invoices[0] as { currency: string }).currency
          : 'USD',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/clients/[id]/profitability error')
    return NextResponse.json({ error: 'Failed to generate profitability report' }, { status: 500 })
  }
}
