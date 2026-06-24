import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_ENTITY_TYPES = ['invoices', 'transactions', 'clients'] as const
type EntityType = typeof VALID_ENTITY_TYPES[number]

const MAX_EXPORT_LIMIT = 500
const DEFAULT_EXPORT_LIMIT = 100

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const b = body as Record<string, unknown>

    const entityType = typeof b?.entityType === 'string' ? b.entityType : ''
    if (!VALID_ENTITY_TYPES.includes(entityType as EntityType)) {
      return NextResponse.json(
        { error: `entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}` },
        { status: 400 },
      )
    }

    const fromParam = typeof b?.from === 'string' ? b.from : null
    const toParam = typeof b?.to === 'string' ? b.to : null

    const from = fromParam ? new Date(fromParam) : null
    const to = toParam ? new Date(toParam) : null

    if (fromParam && isNaN(from!.getTime())) {
      return NextResponse.json({ error: 'Invalid from date' }, { status: 400 })
    }
    if (toParam && isNaN(to!.getTime())) {
      return NextResponse.json({ error: 'Invalid to date' }, { status: 400 })
    }

    const rawLimit = typeof b?.limit === 'number' ? b.limit : DEFAULT_EXPORT_LIMIT
    const limit = Math.max(1, Math.min(MAX_EXPORT_LIMIT, rawLimit))

    const dateFilter = from || to
      ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}

    let records: Array<Record<string, unknown>> = []

    if (entityType === 'invoices') {
      const invoices = await prisma.invoice.findMany({
        where: { userId: user.id, ...dateFilter },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          invoiceNumber: true,
          clientEmail: true,
          clientName: true,
          amount: true,
          currency: true,
          status: true,
          dueDate: true,
          createdAt: true,
        },
      })
      records = invoices.map((inv) => ({
        ...inv,
        amount: Number(inv.amount),
      }))
    } else if (entityType === 'transactions') {
      const transactions = await prisma.transaction.findMany({
        where: { userId: user.id, ...dateFilter },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          type: true,
          status: true,
          amount: true,
          currency: true,
          createdAt: true,
        },
      })
      records = transactions.map((tx) => ({
        ...tx,
        amount: Number(tx.amount),
      }))
    } else if (entityType === 'clients') {
      const invoices = await prisma.invoice.findMany({
        where: { userId: user.id },
        select: { clientEmail: true, clientName: true },
        distinct: ['clientEmail'],
        take: limit,
      })
      records = invoices.map((inv) => ({
        email: inv.clientEmail,
        name: inv.clientName,
      }))
    }

    return NextResponse.json({
      export: {
        entityType,
        count: records.length,
        records,
        exportedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/integrations/quickbooks/export error')
    return NextResponse.json({ error: 'Failed to export data' }, { status: 500 })
  }
}
