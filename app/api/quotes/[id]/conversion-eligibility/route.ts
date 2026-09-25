import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  evaluateQuoteConversionEligibility,
  referencedProductIds,
} from '@/lib/quote-conversion'

// GET /api/quotes/[id]/conversion-eligibility — report whether a quote can
// still be converted into an invoice and, if not, every reason why.
// Read-only: never changes the quote or creates an invoice.

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const quote = await prisma.quote.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        invoiceId: true,
        lineItems: {
          select: { id: true, productId: true },
          orderBy: { position: 'asc' },
        },
      },
    })

    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    const productIds = referencedProductIds(quote)
    const products = productIds.length
      ? await prisma.product.findMany({
          where: { id: { in: productIds }, userId: user.id },
          select: { id: true, isActive: true },
        })
      : []

    const checkedAt = new Date()
    const reasons = evaluateQuoteConversionEligibility(quote, products, checkedAt)

    return NextResponse.json({
      quoteId: quote.id,
      eligible: reasons.length === 0,
      reasons,
      checkedAt: checkedAt.toISOString(),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/quotes/[id]/conversion-eligibility error')
    return NextResponse.json({ error: 'Failed to check quote conversion eligibility' }, { status: 500 })
  }
}
