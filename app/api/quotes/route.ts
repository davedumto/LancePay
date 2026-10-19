import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return { error: NextResponse.json({ error: 'User not found' }, { status: 404 }) }
  }

  return { user }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) {
      return auth.error
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1)
    const limit = Math.min(
      50,
      Math.max(1, Number.parseInt(searchParams.get('limit') || '20', 10) || 20),
    )

    const validStatuses = ['draft', 'sent', 'accepted', 'declined', 'expired', 'converted']
    if (status && !validStatuses.includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }

    const where = {
      userId: auth.user.id,
      ...(status ? { status } : {}),
    }

    const total = await prisma.quote.count({ where })
    const quotes = await prisma.quote.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        lineItems: {
          select: {
            id: true,
            description: true,
            quantity: true,
            unitPrice: true,
            position: true,
          },
          orderBy: { position: 'asc' },
        },
      },
    })

    return NextResponse.json({
      quotes: quotes.map((q) => ({
        id: q.id,
        clientEmail: q.clientEmail,
        clientName: q.clientName,
        description: q.description,
        amount: Number(q.amount),
        currency: q.currency,
        status: q.status,
        expiresAt: q.expiresAt,
        createdAt: q.createdAt,
        lineItems: q.lineItems.map((item) => ({
          id: item.id,
          description: item.description,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          position: item.position,
        })),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('GET /api/quotes error:', error)
    return NextResponse.json({ error: 'Failed to retrieve quotes' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) {
      return auth.error
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { clientEmail, clientName, description, currency = 'USD', expiresAt, lineItems } = body

    // Validate clientEmail
    if (!clientEmail || typeof clientEmail !== 'string') {
      return NextResponse.json(
        { error: 'clientEmail is required' },
        { status: 400 },
      )
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail.trim())) {
      return NextResponse.json(
        { error: 'clientEmail must be a valid email address' },
        { status: 400 },
      )
    }

    // Validate at least one line item
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return NextResponse.json(
        { error: 'At least one line item is required' },
        { status: 400 },
      )
    }

    // Validate line items
    let totalAmount = 0
    const validatedLineItems: Array<{
      description: string
      quantity: number
      unitPrice: number
      position: number
    }> = []

    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i]
      if (typeof item !== 'object' || item === null) {
        return NextResponse.json(
          { error: 'Each line item must be an object' },
          { status: 400 },
        )
      }

      const { description: itemDesc, quantity, unitPrice } = item as any

      if (typeof itemDesc !== 'string' || itemDesc.trim() === '') {
        return NextResponse.json(
          { error: `Line item ${i + 1}: description is required and must be non-empty` },
          { status: 400 },
        )
      }

      const qty = Number(quantity)
      if (!Number.isFinite(qty) || qty <= 0) {
        return NextResponse.json(
          { error: `Line item ${i + 1}: quantity must be a positive number` },
          { status: 400 },
        )
      }

      const price = Number(unitPrice)
      if (!Number.isFinite(price) || price < 0) {
        return NextResponse.json(
          { error: `Line item ${i + 1}: unitPrice must be a non-negative number` },
          { status: 400 },
        )
      }

      const lineTotal = qty * price
      totalAmount += lineTotal

      validatedLineItems.push({
        description: itemDesc.trim(),
        quantity: qty,
        unitPrice: price,
        position: i,
      })
    }

    if (totalAmount <= 0) {
      return NextResponse.json(
        { error: 'Quote total must be greater than zero' },
        { status: 400 },
      )
    }

    let parsedExpiresAt: Date | null = null
    if (expiresAt) {
      if (typeof expiresAt !== 'string') {
        return NextResponse.json(
          { error: 'expiresAt must be a valid date string' },
          { status: 400 },
        )
      }
      parsedExpiresAt = new Date(expiresAt)
      if (Number.isNaN(parsedExpiresAt.getTime())) {
        return NextResponse.json(
          { error: 'expiresAt must be a valid date string' },
          { status: 400 },
        )
      }
    }

    // Create quote with line items
    const quote = await prisma.quote.create({
      data: {
        userId: auth.user.id,
        clientEmail: clientEmail.trim().toLowerCase(),
        clientName: typeof clientName === 'string' ? clientName.trim() : null,
        description: typeof description === 'string' ? description.trim() : '',
        amount: totalAmount,
        currency: String(currency),
        status: 'draft',
        expiresAt: parsedExpiresAt,
        lineItems: {
          create: validatedLineItems,
        },
      },
      select: {
        id: true,
        clientEmail: true,
        clientName: true,
        description: true,
        amount: true,
        currency: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        lineItems: {
          select: {
            id: true,
            description: true,
            quantity: true,
            unitPrice: true,
            position: true,
          },
          orderBy: { position: 'asc' },
        },
      },
    })

    return NextResponse.json(
      {
        id: quote.id,
        clientEmail: quote.clientEmail,
        clientName: quote.clientName,
        description: quote.description,
        amount: Number(quote.amount),
        currency: quote.currency,
        status: quote.status,
        expiresAt: quote.expiresAt,
        createdAt: quote.createdAt,
        lineItems: quote.lineItems.map((item) => ({
          id: item.id,
          description: item.description,
          quantity: Number(item.quantity),
          unitPrice: Number(item.unitPrice),
          position: item.position,
        })),
      },
      { status: 201 },
    )
  } catch (error) {
    console.error('POST /api/quotes error:', error)
    return NextResponse.json({ error: 'Failed to create quote' }, { status: 500 })
  }
}
