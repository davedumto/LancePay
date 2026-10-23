import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const MAX_DESCRIPTION_LENGTH = 500

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

async function findOwnedQuote(quoteId: string, userId: string) {
  return prisma.quote.findFirst({
    where: { id: quoteId, userId },
    select: { id: true, invoiceId: true, amount: true },
  })
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

async function recomputeQuoteTotal(quoteId: string) {
  const lineItems = await prisma.quoteLineItem.findMany({
    where: { quoteId },
    select: { quantity: true, unitPrice: true },
  })

  const total = lineItems.reduce((sum, item) => {
    const qty = Number(item.quantity) || 0
    const price = Number(item.unitPrice) || 0
    return sum + qty * price
  }, 0)

  await prisma.quote.update({
    where: { id: quoteId },
    data: { amount: total },
  })

  return total
}

/**
 * GET /api/quotes/[id]/line-items
 * List all line items for a quote, ordered by position.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: quoteId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!quoteId || !quoteId.trim()) {
      return NextResponse.json({ error: 'Quote ID is required' }, { status: 400 })
    }

    const quote = await findOwnedQuote(quoteId, user.id)
    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    const lineItems = await prisma.quoteLineItem.findMany({
      where: { quoteId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        productId: true,
        description: true,
        quantity: true,
        unitPrice: true,
        position: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({
      lineItems: lineItems.map((item) => ({
        ...item,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/quotes/[id]/line-items error')
    return NextResponse.json({ error: 'Failed to fetch quote line items' }, { status: 500 })
  }
}

/**
 * POST /api/quotes/[id]/line-items
 * Add a new line item to a quote.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: quoteId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!quoteId || !quoteId.trim()) {
      return NextResponse.json({ error: 'Quote ID is required' }, { status: 400 })
    }

    const quote = await findOwnedQuote(quoteId, user.id)
    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    if (quote.invoiceId) {
      return NextResponse.json(
        { error: 'Cannot add a line item to a quote that has been converted to an invoice' },
        { status: 409 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { description, quantity, unitPrice, productId } = payload

    if (typeof description !== 'string' || !description.trim()) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }

    if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json(
        { error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` },
        { status: 400 },
      )
    }

    if (!isFiniteNumber(quantity) || quantity < 0) {
      return NextResponse.json({ error: 'quantity must be a non-negative number' }, { status: 400 })
    }

    if (!isFiniteNumber(unitPrice) || unitPrice < 0) {
      return NextResponse.json({ error: 'unitPrice must be a non-negative number' }, { status: 400 })
    }

    const lastLineItem = await prisma.quoteLineItem.findFirst({
      where: { quoteId },
      orderBy: { position: 'desc' },
      select: { position: true },
    })
    const position = (lastLineItem?.position ?? -1) + 1

    const lineItem = await prisma.quoteLineItem.create({
      data: {
        quoteId,
        productId: typeof productId === 'string' ? productId : null,
        description: description.trim(),
        quantity,
        unitPrice,
        position,
      },
      select: {
        id: true,
        productId: true,
        description: true,
        quantity: true,
        unitPrice: true,
        position: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    await recomputeQuoteTotal(quoteId)

    return NextResponse.json(
      {
        lineItem: {
          ...lineItem,
          quantity: Number(lineItem.quantity),
          unitPrice: Number(lineItem.unitPrice),
          createdAt: lineItem.createdAt.toISOString(),
          updatedAt: lineItem.updatedAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/quotes/[id]/line-items error')
    return NextResponse.json({ error: 'Failed to add quote line item' }, { status: 500 })
  }
}

/**
 * PATCH /api/quotes/[id]/line-items
 * Update multiple line items at once (used for reordering and bulk updates).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: quoteId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!quoteId || !quoteId.trim()) {
      return NextResponse.json({ error: 'Quote ID is required' }, { status: 400 })
    }

    const quote = await findOwnedQuote(quoteId, user.id)
    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    if (quote.invoiceId) {
      return NextResponse.json(
        { error: 'Cannot update line items on a quote that has been converted to an invoice' },
        { status: 409 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { lineItems } = payload

    if (!Array.isArray(lineItems)) {
      return NextResponse.json({ error: 'lineItems must be an array' }, { status: 400 })
    }

    for (const item of lineItems) {
      if (typeof item !== 'object' || item === null) {
        return NextResponse.json({ error: 'Each line item must be an object' }, { status: 400 })
      }

      const itemData = item as Record<string, unknown>

      if (typeof itemData.id !== 'string' || !itemData.id.trim()) {
        return NextResponse.json({ error: 'Each line item must have an id' }, { status: 400 })
      }

      if (itemData.description !== undefined) {
        if (typeof itemData.description !== 'string' || !itemData.description.trim()) {
          return NextResponse.json({ error: 'description must be a non-empty string' }, { status: 400 })
        }
        if (itemData.description.trim().length > MAX_DESCRIPTION_LENGTH) {
          return NextResponse.json(
            { error: `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer` },
            { status: 400 },
          )
        }
      }

      if (itemData.quantity !== undefined) {
        if (!isFiniteNumber(itemData.quantity) || itemData.quantity < 0) {
          return NextResponse.json({ error: 'quantity must be a non-negative number' }, { status: 400 })
        }
      }

      if (itemData.unitPrice !== undefined) {
        if (!isFiniteNumber(itemData.unitPrice) || itemData.unitPrice < 0) {
          return NextResponse.json({ error: 'unitPrice must be a non-negative number' }, { status: 400 })
        }
      }

      if (itemData.position !== undefined) {
        if (typeof itemData.position !== 'number' || !Number.isInteger(itemData.position) || itemData.position < 0) {
          return NextResponse.json({ error: 'position must be a non-negative integer' }, { status: 400 })
        }
      }
    }

    for (const item of lineItems) {
      const itemData = item as Record<string, unknown>
      const updateData: Record<string, unknown> = {}

      if (itemData.description !== undefined) {
        updateData.description = (itemData.description as string).trim()
      }
      if (itemData.quantity !== undefined) {
        updateData.quantity = itemData.quantity
      }
      if (itemData.unitPrice !== undefined) {
        updateData.unitPrice = itemData.unitPrice
      }
      if (itemData.position !== undefined) {
        updateData.position = itemData.position
      }
      if (itemData.productId !== undefined) {
        updateData.productId = typeof itemData.productId === 'string' ? itemData.productId : null
      }

      await prisma.quoteLineItem.update({
        where: { id: itemData.id as string },
        data: updateData,
      })
    }

    await recomputeQuoteTotal(quoteId)

    const updatedLineItems = await prisma.quoteLineItem.findMany({
      where: { quoteId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        productId: true,
        description: true,
        quantity: true,
        unitPrice: true,
        position: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({
      lineItems: updatedLineItems.map((item) => ({
        ...item,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'PATCH /api/quotes/[id]/line-items error')
    return NextResponse.json({ error: 'Failed to update quote line items' }, { status: 500 })
  }
}

/**
 * DELETE /api/quotes/[id]/line-items
 * Delete multiple line items at once.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: quoteId } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!quoteId || !quoteId.trim()) {
      return NextResponse.json({ error: 'Quote ID is required' }, { status: 400 })
    }

    const quote = await findOwnedQuote(quoteId, user.id)
    if (!quote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    if (quote.invoiceId) {
      return NextResponse.json(
        { error: 'Cannot delete line items from a quote that has been converted to an invoice' },
        { status: 409 },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { ids } = payload

    if (!Array.isArray(ids)) {
      return NextResponse.json({ error: 'ids must be an array' }, { status: 400 })
    }

    if (ids.length === 0) {
      return NextResponse.json({ error: 'ids must not be empty' }, { status: 400 })
    }

    for (const id of ids) {
      if (typeof id !== 'string' || !id.trim()) {
        return NextResponse.json({ error: 'Each id must be a string' }, { status: 400 })
      }
    }

    await prisma.quoteLineItem.deleteMany({
      where: {
        id: { in: ids as string[] },
        quoteId,
      },
    })

    await recomputeQuoteTotal(quoteId)

    const remainingLineItems = await prisma.quoteLineItem.findMany({
      where: { quoteId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        productId: true,
        description: true,
        quantity: true,
        unitPrice: true,
        position: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json({
      lineItems: remainingLineItems.map((item) => ({
        ...item,
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'DELETE /api/quotes/[id]/line-items error')
    return NextResponse.json({ error: 'Failed to delete quote line items' }, { status: 500 })
  }
}
