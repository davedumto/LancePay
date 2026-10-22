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
  invoiceId: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  lineItems: {
    select: {
      id: true,
      productId: true,
      description: true,
      quantity: true,
      unitPrice: true,
      position: true,
    },
  },
}

/**
 * GET /api/quotes/[id]
 * Fetch a single quote by ID, restricted to the authenticated owner.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id || !id.trim()) {
      return NextResponse.json({ error: 'Quote ID is required' }, { status: 400 })
    }

    const quote = await prisma.quote.findFirst({
      where: { id, userId: user.id },
      select: SELECT_FIELDS,
    })

    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    return NextResponse.json({
      quote: {
        ...quote,
        amount: Number(quote.amount),
        lineItems: quote.lineItems.map((item) => ({
          ...item,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
        })),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/quotes/[id] error')
    return NextResponse.json({ error: 'Failed to fetch quote' }, { status: 500 })
  }
}

/**
 * PATCH /api/quotes/[id]
 * Update a quote. Rejects updates if the quote has been converted to an invoice.
 * Recomputes the stored total if line items are changed.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { id } = await params
    if (!id || !id.trim()) {
      return NextResponse.json({ error: 'Quote ID is required' }, { status: 400 })
    }

    const quote = await prisma.quote.findFirst({
      where: { id, userId: user.id },
      select: { id: true, invoiceId: true },
    })

    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    if (quote.invoiceId) {
      return NextResponse.json(
        { error: 'Cannot update a quote that has been converted to an invoice' },
        { status: 409 },
      )
    }

    const body = await request.json()
    const { clientEmail, clientName, description, amount, currency, lineItems } = body

    let newTotal = null

    // If line items are provided, recompute the total
    if (lineItems && Array.isArray(lineItems)) {
      // Start a transaction to update the quote and line items
      const updateData: any = {
        ...(clientEmail !== undefined && { clientEmail }),
        ...(clientName !== undefined && { clientName }),
        ...(description !== undefined && { description }),
        ...(currency !== undefined && { currency }),
      }

      // Delete existing line items and create new ones
      await prisma.quoteLineItem.deleteMany({ where: { quoteId: id } })

      // Recalculate total from provided line items
      newTotal = lineItems.reduce((sum: number, item: any) => {
        const qty = Number(item.quantity) || 0
        const price = Number(item.unitPrice) || 0
        return sum + qty * price
      }, 0)

      updateData.amount = newTotal

      const updatedQuote = await prisma.quote.update({
        where: { id },
        data: updateData,
        select: SELECT_FIELDS,
      })

      // Create new line items
      if (lineItems.length > 0) {
        await prisma.quoteLineItem.createMany({
          data: lineItems.map((item: any, index: number) => ({
            quoteId: id,
            productId: item.productId || null,
            description: item.description,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            position: index,
          })),
        })
      }

      // Fetch updated quote with line items
      const result = await prisma.quote.findFirst({
        where: { id },
        select: SELECT_FIELDS,
      })

      return NextResponse.json({
        quote: {
          ...result,
          amount: Number(result!.amount),
          lineItems: result!.lineItems.map((item) => ({
            ...item,
            quantity: Number(item.quantity),
            unitPrice: Number(item.unitPrice),
          })),
        },
      })
    } else {
      // No line items, just update basic fields
      const updateData: any = {}
      if (clientEmail !== undefined) updateData.clientEmail = clientEmail
      if (clientName !== undefined) updateData.clientName = clientName
      if (description !== undefined) updateData.description = description
      if (amount !== undefined) updateData.amount = amount
      if (currency !== undefined) updateData.currency = currency

      const updatedQuote = await prisma.quote.update({
        where: { id },
        data: updateData,
        select: SELECT_FIELDS,
      })

      return NextResponse.json({
        quote: {
          ...updatedQuote,
          amount: Number(updatedQuote.amount),
          lineItems: updatedQuote.lineItems.map((item) => ({
            ...item,
            quantity: Number(item.quantity),
            unitPrice: Number(item.unitPrice),
          })),
        },
      })
    }
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/quotes/[id] error')
    return NextResponse.json({ error: 'Failed to update quote' }, { status: 500 })
  }
}
