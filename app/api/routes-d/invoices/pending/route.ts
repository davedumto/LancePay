import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_LIMIT = 50
const DEFAULT_LIMIT = 20

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null

  const claims = await verifyAuthToken(authToken)
  if (!claims) return null

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })

  return user ?? null
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const cursor = searchParams.get('cursor') ?? undefined
    const limitParam = searchParams.get('limit')

    const limit = Math.min(
      limitParam ? Math.max(1, parseInt(limitParam, 10) || DEFAULT_LIMIT) : DEFAULT_LIMIT,
      MAX_LIMIT,
    )

    const invoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        status: 'pending',
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        invoiceNumber: true,
        clientName: true,
        clientEmail: true,
        amount: true,
        currency: true,
        dueDate: true,
        createdAt: true,
      },
    })

    const hasNext = invoices.length > limit
    const page = hasNext ? invoices.slice(0, limit) : invoices
    const nextCursor = hasNext ? page[page.length - 1]?.id ?? null : null

    return NextResponse.json({
      data: page.map((i) => ({ ...i, amount: Number(i.amount) })),
      nextCursor,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/invoices/pending error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}