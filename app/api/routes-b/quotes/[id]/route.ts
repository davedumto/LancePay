import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const SELECT_FIELDS = {
  id: true,
  clientEmail: true,
  clientName: true,
  description: true,
  amount: true,
  currency: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
}

export async function GET(
  request: NextRequest,
  { params }: any
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const quoteId = (await params).
    if (!quoteId || !quoteId.trim()) {
      return NextResponse.json({ error: 'Quote id is required' }, { status: 400 })
    }

    const quote = await prisma.quote.findFirst({
      where: { id: quoteId, userId: user.id },
      select: SELECT_FIELDS,
    })

    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    return NextResponse.json({
      quote: {
        ...quote,
        amount: Number(quote.amount),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-b/quotes/[id] error')
    return NextResponse.json({ error: 'Failed to fetch quote' }, { status: 500 })
  }
}
