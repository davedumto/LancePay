import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import {
  evaluateQuoteConversionEligibility,
  referencedProductIds,
} from '@/lib/quote-conversion'
import { generateInvoiceNumber } from '@/lib/utils'

// POST /api/quotes/[id]/convert — convert an eligible quote into an invoice.
// Performs the same eligibility checks as the conversion-eligibility endpoint;
// if any check fails, rejects the request and returns the reasons.

export async function POST(
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
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        lineItems: {
          select: { id: true, productId: true },
          orderBy: { position: 'asc' },
        },
      },
    })

    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    // Run the same eligibility checks
    const productIds = referencedProductIds(quote)
    const products = productIds.length
      ? await prisma.product.findMany({
          where: { id: { in: productIds }, userId: user.id },
          select: { id: true, isActive: true },
        })
      : []

    const checkedAt = new Date()
    const reasons = evaluateQuoteConversionEligibility(quote, products, checkedAt)

    if (reasons.length > 0) {
      return NextResponse.json(
        {
          error: 'Quote is not eligible for conversion',
          reasons,
        },
        { status: 403 },
      )
    }

    // Convert the quote to an invoice
    const invoiceNumber = generateInvoiceNumber()
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`
    const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

    const result = await prisma.$transaction(async (tx) => {
      // Create the invoice from the quote
      const invoice = await tx.invoice.create({
        data: {
          userId: user.id,
          invoiceNumber,
          clientEmail: quote.clientEmail,
          clientName: quote.clientName,
          description: quote.description,
          amount: quote.amount,
          currency: quote.currency,
          paymentLink,
          status: 'pending',
        },
      })

      // Mark the quote as converted and link it to the invoice
      await tx.quote.update({
        where: { id: quote.id },
        data: {
          status: 'converted',
          invoiceId: invoice.id,
        },
      })

      return invoice
    })

    return NextResponse.json(
      {
        message: 'Quote converted to invoice',
        invoice: {
          id: result.id,
          invoiceNumber: result.invoiceNumber,
          clientEmail: result.clientEmail,
          clientName: result.clientName,
          description: result.description,
          amount: Number(result.amount),
          currency: result.currency,
          status: result.status,
          paymentLink: result.paymentLink,
          createdAt: result.createdAt,
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/quotes/[id]/convert error')
    return NextResponse.json({ error: 'Failed to convert quote' }, { status: 500 })
  }
}
