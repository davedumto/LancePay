import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

function parseLimit(rawLimit: string | null): number {
  if (!rawLimit) return DEFAULT_LIMIT

  const parsed = Number.parseInt(rawLimit, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT

  return Math.min(parsed, MAX_LIMIT)
}

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const limit = parseLimit(request.nextUrl.searchParams.get('limit'))

  const grouped = await prisma.invoice.groupBy({
    by: ['clientEmail'],
    where: { userId: user.id },
    _count: { id: true },
    _sum: { amount: true },
    orderBy: { _sum: { amount: 'desc' } },
    take: limit,
  })

  if (grouped.length === 0) {
    return NextResponse.json({ clients: [] })
  }

  const clientEmails = grouped.map((group) => group.clientEmail)

  const paidCounts = await prisma.invoice.groupBy({
    by: ['clientEmail'],
    where: {
      userId: user.id,
      status: 'paid',
      clientEmail: { in: clientEmails },
    },
    _count: { id: true },
  })

  const paidCountByEmail = new Map(
    paidCounts.map((group) => [group.clientEmail, group._count.id]),
  )

  const clientNames = await prisma.invoice.findMany({
    where: {
      userId: user.id,
      clientEmail: { in: clientEmails },
    },
    select: {
      clientEmail: true,
      clientName: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  const clientNameByEmail = new Map<string, string | null>()
  for (const client of clientNames) {
    if (!clientNameByEmail.has(client.clientEmail)) {
      clientNameByEmail.set(client.clientEmail, client.clientName)
    }
  }

  return NextResponse.json({
    clients: grouped.map((group) => ({
      clientEmail: group.clientEmail,
      clientName: clientNameByEmail.get(group.clientEmail) || null,
      totalInvoiced: Number(group._sum.amount || 0),
      invoiceCount: group._count.id,
      paidCount: paidCountByEmail.get(group.clientEmail) || 0,
    })),
  })
}
