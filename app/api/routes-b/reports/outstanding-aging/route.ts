import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const BUCKETS = [
  { label: 'current', minDays: 0, maxDays: 0 },
  { label: '1-30', minDays: 1, maxDays: 30 },
  { label: '31-60', minDays: 31, maxDays: 60 },
  { label: '61-90', minDays: 61, maxDays: 90 },
  { label: '90+', minDays: 91, maxDays: Infinity },
] as const

async function GETHandler(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const { searchParams } = new URL(request.url)
  const currency = searchParams.get('currency') ?? 'USD'

  const outstanding = await prisma.invoice.findMany({
    where: {
      userId: user.id,
      status: { in: ['pending', 'overdue'] },
      currency: currency.toUpperCase(),
    },
    select: { id: true, amount: true, dueDate: true, status: true },
  })

  const now = Date.now()
  const buckets: Record<string, { count: number; total: number }> = {}
  for (const b of BUCKETS) buckets[b.label] = { count: 0, total: 0 }

  for (const inv of outstanding) {
    const dueDate = inv.dueDate ? new Date(inv.dueDate).getTime() : now
    const daysPastDue = inv.status === 'overdue'
      ? Math.max(0, Math.floor((now - dueDate) / 86_400_000))
      : 0

    const bucket = BUCKETS.find(
      (b) => daysPastDue >= b.minDays && daysPastDue <= b.maxDays,
    ) ?? BUCKETS[BUCKETS.length - 1]

    buckets[bucket.label].count += 1
    buckets[bucket.label].total += Number(inv.amount)
  }

  const total = Object.values(buckets).reduce((s, b) => s + b.total, 0)

  logger.info({ userId: user.id, currency, totalOutstanding: total }, 'Outstanding aging report')

  return NextResponse.json({
    currency,
    totalOutstanding: total,
    buckets,
    generatedAt: new Date().toISOString(),
  })
}

export const GET = withRequestId(GETHandler)
