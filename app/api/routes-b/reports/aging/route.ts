import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const BUCKETS = [
  { label: 'current', minDays: -Infinity, maxDays: 0 },
  { label: '1-30', minDays: 1, maxDays: 30 },
  { label: '31-60', minDays: 31, maxDays: 60 },
  { label: '61-90', minDays: 61, maxDays: 90 },
  { label: '90+', minDays: 91, maxDays: Infinity },
] as const

type BucketLabel = typeof BUCKETS[number]['label']

interface AgingBucket {
  label: BucketLabel
  count: number
  totalAmount: number
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const now = new Date()

    const openInvoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: { in: ['pending', 'overdue'] },
      },
      select: {
        id: true,
        amount: true,
        dueDate: true,
        status: true,
        clientName: true,
        clientEmail: true,
      },
    })

    const buckets: Record<BucketLabel, AgingBucket> = {
      current: { label: 'current', count: 0, totalAmount: 0 },
      '1-30': { label: '1-30', count: 0, totalAmount: 0 },
      '31-60': { label: '31-60', count: 0, totalAmount: 0 },
      '61-90': { label: '61-90', count: 0, totalAmount: 0 },
      '90+': { label: '90+', count: 0, totalAmount: 0 },
    }

    const agingItems = openInvoices.map((inv) => {
      const amount = Number(inv.amount)
      const dueDate = inv.dueDate ? new Date(inv.dueDate) : null
      const daysOverdue = dueDate
        ? Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
        : 0

      const bucket = BUCKETS.find(
        (b) => daysOverdue >= b.minDays && daysOverdue <= b.maxDays,
      ) ?? BUCKETS[BUCKETS.length - 1]

      buckets[bucket.label].count += 1
      buckets[bucket.label].totalAmount += amount

      return {
        invoiceId: inv.id,
        clientName: inv.clientName ?? null,
        clientEmail: inv.clientEmail,
        amount,
        dueDate: dueDate?.toISOString() ?? null,
        daysOverdue: Math.max(0, daysOverdue),
        agingBucket: bucket.label,
        status: inv.status,
      }
    })

    const summary = Object.values(buckets).map((b) => ({
      label: b.label,
      count: b.count,
      totalAmount: Math.round(b.totalAmount * 100) / 100,
    }))

    const grandTotal = openInvoices.reduce((s, inv) => s + Number(inv.amount), 0)

    return NextResponse.json({
      currency: 'USDC',
      totalOutstanding: Math.round(grandTotal * 100) / 100,
      openInvoiceCount: openInvoices.length,
      summary,
      items: agingItems,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/reports/aging error')
    return NextResponse.json({ error: 'Failed to generate aging report' }, { status: 500 })
  }
}
