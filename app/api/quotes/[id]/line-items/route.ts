import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function resolveQuoteId(context?: RouteContext): Promise<string> {
  if (!context?.params) return ''
  const resolved = await Promise.resolve(context.params)
  return (resolved?.id ?? '').trim()
}

async function resolveAuthenticatedUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }
  const token = authHeader.slice(7).trim()
  if (!token) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  const claims = await verifyAuthToken(token)
  if (!claims) {
    return { error: 'Unauthorized', status: 401 as const, user: null }
  }

  let userId = claims.userId
  if (typeof prisma.user?.findUnique === 'function') {
    const dbUser =
      (await prisma.user.findUnique({
        where: { privyId: claims.userId },
        select: { id: true },
      })) ??
      (await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true },
      }))

    if (!dbUser) {
      return { error: 'User not found', status: 404 as const, user: null }
    }
    userId = dbUser.id
  }

  return { error: null, status: 200 as const, user: { id: userId } }
}

async function loadOwnedQuote(quoteId: string, userId: string) {
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
  })
  if (!quote) {
    return {
      error: 'Quote not found',
      code: 'QUOTE_NOT_FOUND',
      status: 404 as const,
      quote: null,
    }
  }
  if (quote.userId !== userId) {
    return {
      error: 'Forbidden: quote belongs to another user',
      code: 'FORBIDDEN_QUOTE_OWNER',
      status: 403 as const,
      quote: null,
    }
  }
  return { error: null, code: null, status: 200 as const, quote }
}

function roundToCents(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100
}

function formatLineItem(item: Record<string, any>) {
  const quantity = Number(item.quantity ?? 0)
  const unitPrice = Number(item.unitPrice ?? 0)
  const lineTotal = roundToCents(quantity * unitPrice)

  return {
    id: item.id,
    quoteId: item.quoteId,
    productId: item.productId ?? null,
    description: item.description,
    quantity,
    unitPrice,
    lineTotal,
    position: Number(item.position ?? 0),
    createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : null,
    updatedAt: item.updatedAt ? new Date(item.updatedAt).toISOString() : null,
  }
}

async function recomputeAndSyncQuoteTotal(quoteId: string) {
  const rawItems = (await prisma.quoteLineItem.findMany({
    where: { quoteId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  })) as Array<Record<string, any>>

  // Sort deterministically by position ascending
  const sorted = [...(rawItems ?? [])].sort(
    (a, b) => Number(a.position ?? 0) - Number(b.position ?? 0),
  )

  const lineItems = sorted.map(formatLineItem)
  const total = roundToCents(
    lineItems.reduce((sum, item) => sum + item.lineTotal, 0),
  )

  if (typeof prisma.quote?.update === 'function') {
    await prisma.quote.update({
      where: { id: quoteId },
      data: { amount: total },
    })
  }

  return { lineItems, total }
}

/**
 * GET /api/quotes/[id]/line-items
 * Lists line items for a quote in ascending `position` order along with the computed `total`.
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const quoteId = await resolveQuoteId(context)
    if (!quoteId) {
      return NextResponse.json(
        { error: 'Quote ID is required' },
        { status: 400 },
      )
    }

    const owned = await loadOwnedQuote(quoteId, auth.user.id)
    if (owned.error || !owned.quote) {
      return NextResponse.json(
        { error: owned.error, code: owned.code },
        { status: owned.status },
      )
    }

    const rawItems = (await prisma.quoteLineItem.findMany({
      where: { quoteId: owned.quote.id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    })) as Array<Record<string, any>>

    const sorted = [...(rawItems ?? [])].sort(
      (a, b) => Number(a.position ?? 0) - Number(b.position ?? 0),
    )
    const lineItems = sorted.map(formatLineItem)
    const total = roundToCents(
      lineItems.reduce((sum, item) => sum + item.lineTotal, 0),
    )

    return NextResponse.json({
      quoteId: owned.quote.id,
      lineItems,
      total,
      quoteTotal: total,
    })
  } catch (err) {
    logger?.error?.({ err }, 'GET /api/quotes/[id]/line-items error')
    return NextResponse.json(
      { error: 'Failed to list quote line items' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/quotes/[id]/line-items
 * Adds a structured line item (`QuoteLineItem`) to a quote:
 * - Validates `quantity` and `unitPrice` are non-negative.
 * - Assigns a stable `position` (either user-supplied or appended at the end, shifting existing items if inserted in the middle).
 * - Recomputes the quote's `total` (`quote.amount`) whenever line items change.
 */
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const quoteId = await resolveQuoteId(context)
    if (!quoteId) {
      return NextResponse.json(
        { error: 'Quote ID is required' },
        { status: 400 },
      )
    }

    const owned = await loadOwnedQuote(quoteId, auth.user.id)
    if (owned.error || !owned.quote) {
      return NextResponse.json(
        { error: owned.error, code: owned.code },
        { status: owned.status },
      )
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    const description =
      typeof body.description === 'string' ? body.description.trim() : ''
    if (!description || description.length > 500) {
      return NextResponse.json(
        {
          error: 'description is required and must be at most 500 characters',
          code: 'INVALID_LINE_ITEM_DESCRIPTION',
        },
        { status: 400 },
      )
    }

    const quantity =
      typeof body.quantity === 'number' ? body.quantity : Number(body.quantity)
    if (!Number.isFinite(quantity) || quantity < 0) {
      return NextResponse.json(
        {
          error: 'quantity must be a non-negative number',
          code: 'INVALID_QUANTITY',
        },
        { status: 400 },
      )
    }

    const unitPrice =
      typeof body.unitPrice === 'number'
        ? body.unitPrice
        : Number(body.unitPrice)
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return NextResponse.json(
        {
          error: 'unitPrice must be a non-negative number',
          code: 'INVALID_UNIT_PRICE',
        },
        { status: 400 },
      )
    }

    const existingItems = ((await prisma.quoteLineItem.findMany({
      where: { quoteId: owned.quote.id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    })) ?? []) as Array<Record<string, any>>

    let position: number
    if (body.position !== undefined && body.position !== null) {
      const parsedPos = Number(body.position)
      if (!Number.isInteger(parsedPos) || parsedPos < 0) {
        return NextResponse.json(
          {
            error: 'position must be a non-negative integer',
            code: 'INVALID_POSITION',
          },
          { status: 400 },
        )
      }
      position = parsedPos

      // Shift existing items at or after this position up by 1 to preserve stable ordering
      if (typeof prisma.quoteLineItem?.update === 'function') {
        for (const existing of existingItems) {
          if (Number(existing.position) >= position) {
            await prisma.quoteLineItem.update({
              where: { id: existing.id },
              data: { position: Number(existing.position) + 1 },
            })
          }
        }
      }
    } else {
      const maxPos = existingItems.reduce(
        (max, it) => Math.max(max, Number(it.position ?? -1)),
        -1,
      )
      position = maxPos + 1
    }

    const productId =
      typeof body.productId === 'string' && body.productId.trim()
        ? body.productId.trim()
        : null

    const created = await prisma.quoteLineItem.create({
      data: {
        quoteId: owned.quote.id,
        productId,
        description,
        quantity,
        unitPrice,
        position,
      },
    })

    const synced = await recomputeAndSyncQuoteTotal(owned.quote.id)

    return NextResponse.json(
      {
        lineItem: formatLineItem(created),
        lineItems: synced.lineItems,
        total: synced.total,
        quoteTotal: synced.total,
      },
      { status: 201 },
    )
  } catch (err) {
    logger?.error?.({ err }, 'POST /api/quotes/[id]/line-items error')
    return NextResponse.json(
      { error: 'Failed to add quote line item' },
      { status: 500 },
    )
  }
}

/**
 * PATCH /api/quotes/[id]/line-items
 * Updates or reorders line items on a quote and recomputes the quote's `total`.
 */
export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const quoteId = await resolveQuoteId(context)
    if (!quoteId) {
      return NextResponse.json(
        { error: 'Quote ID is required' },
        { status: 400 },
      )
    }

    const owned = await loadOwnedQuote(quoteId, auth.user.id)
    if (owned.error || !owned.quote) {
      return NextResponse.json(
        { error: owned.error, code: owned.code },
        { status: owned.status },
      )
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON request body' },
        { status: 400 },
      )
    }

    // Batch reorder via orderedIds: string[]
    if (Array.isArray(body.orderedIds)) {
      for (let idx = 0; idx < body.orderedIds.length; idx++) {
        const id = String(body.orderedIds[idx] ?? '').trim()
        if (!id) continue
        await prisma.quoteLineItem.update({
          where: { id },
          data: { position: idx },
        })
      }

      const synced = await recomputeAndSyncQuoteTotal(owned.quote.id)
      return NextResponse.json({
        lineItems: synced.lineItems,
        total: synced.total,
        quoteTotal: synced.total,
      })
    }

    const itemId =
      typeof body.lineItemId === 'string'
        ? body.lineItemId.trim()
        : typeof body.id === 'string'
          ? body.id.trim()
          : ''
    if (!itemId) {
      return NextResponse.json(
        {
          error: 'lineItemId (or orderedIds) is required',
          code: 'LINE_ITEM_ID_REQUIRED',
        },
        { status: 400 },
      )
    }

    const updateData: Record<string, unknown> = {}
    if (body.description !== undefined) {
      const desc =
        typeof body.description === 'string' ? body.description.trim() : ''
      if (!desc || desc.length > 500) {
        return NextResponse.json(
          {
            error: 'description must be non-empty and at most 500 characters',
            code: 'INVALID_LINE_ITEM_DESCRIPTION',
          },
          { status: 400 },
        )
      }
      updateData.description = desc
    }

    if (body.quantity !== undefined) {
      const qty =
        typeof body.quantity === 'number'
          ? body.quantity
          : Number(body.quantity)
      if (!Number.isFinite(qty) || qty < 0) {
        return NextResponse.json(
          {
            error: 'quantity must be a non-negative number',
            code: 'INVALID_QUANTITY',
          },
          { status: 400 },
        )
      }
      updateData.quantity = qty
    }

    if (body.unitPrice !== undefined) {
      const price =
        typeof body.unitPrice === 'number'
          ? body.unitPrice
          : Number(body.unitPrice)
      if (!Number.isFinite(price) || price < 0) {
        return NextResponse.json(
          {
            error: 'unitPrice must be a non-negative number',
            code: 'INVALID_UNIT_PRICE',
          },
          { status: 400 },
        )
      }
      updateData.unitPrice = price
    }

    if (body.position !== undefined) {
      const pos = Number(body.position)
      if (!Number.isInteger(pos) || pos < 0) {
        return NextResponse.json(
          {
            error: 'position must be a non-negative integer',
            code: 'INVALID_POSITION',
          },
          { status: 400 },
        )
      }
      updateData.position = pos
    }

    const updated = await prisma.quoteLineItem.update({
      where: { id: itemId },
      data: updateData,
    })

    const synced = await recomputeAndSyncQuoteTotal(owned.quote.id)

    return NextResponse.json({
      lineItem: formatLineItem(updated),
      lineItems: synced.lineItems,
      total: synced.total,
      quoteTotal: synced.total,
    })
  } catch (err) {
    logger?.error?.({ err }, 'PATCH /api/quotes/[id]/line-items error')
    return NextResponse.json(
      { error: 'Failed to update quote line item' },
      { status: 500 },
    )
  }
}

/**
 * DELETE /api/quotes/[id]/line-items
 * Removes a line item from a quote, compacts remaining `position` values (0..n-1), and recomputes `total`.
 */
export async function DELETE(req: NextRequest, context: RouteContext) {
  try {
    const auth = await resolveAuthenticatedUser(req)
    if (auth.error || !auth.user) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }

    const quoteId = await resolveQuoteId(context)
    if (!quoteId) {
      return NextResponse.json(
        { error: 'Quote ID is required' },
        { status: 400 },
      )
    }

    const owned = await loadOwnedQuote(quoteId, auth.user.id)
    if (owned.error || !owned.quote) {
      return NextResponse.json(
        { error: owned.error, code: owned.code },
        { status: owned.status },
      )
    }

    const { searchParams } = new URL(req.url)
    let itemId =
      searchParams.get('lineItemId')?.trim() ||
      searchParams.get('id')?.trim() ||
      ''
    if (!itemId) {
      const body = await req.json().catch(() => null)
      if (body && typeof body === 'object') {
        itemId =
          (typeof body.lineItemId === 'string' && body.lineItemId.trim()) ||
          (typeof body.id === 'string' && body.id.trim()) ||
          ''
      }
    }

    if (!itemId) {
      return NextResponse.json(
        {
          error: 'lineItemId is required to delete a quote line item',
          code: 'LINE_ITEM_ID_REQUIRED',
        },
        { status: 400 },
      )
    }

    await prisma.quoteLineItem.delete({
      where: { id: itemId },
    })

    // Compact remaining positions into 0, 1, 2, ...
    const remaining = ((await prisma.quoteLineItem.findMany({
      where: { quoteId: owned.quote.id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    })) ?? []) as Array<Record<string, any>>

    const sortedRemaining = [...remaining].sort(
      (a, b) => Number(a.position ?? 0) - Number(b.position ?? 0),
    )

    if (typeof prisma.quoteLineItem?.update === 'function') {
      for (let i = 0; i < sortedRemaining.length; i++) {
        if (Number(sortedRemaining[i].position) !== i) {
          await prisma.quoteLineItem.update({
            where: { id: sortedRemaining[i].id },
            data: { position: i },
          })
          sortedRemaining[i].position = i
        }
      }
    }

    const synced = await recomputeAndSyncQuoteTotal(owned.quote.id)

    return NextResponse.json({
      deleted: true,
      lineItemId: itemId,
      lineItems: synced.lineItems,
      total: synced.total,
      quoteTotal: synced.total,
    })
  } catch (err) {
    logger?.error?.({ err }, 'DELETE /api/quotes/[id]/line-items error')
    return NextResponse.json(
      { error: 'Failed to delete quote line item' },
      { status: 500 },
    )
  }
}
