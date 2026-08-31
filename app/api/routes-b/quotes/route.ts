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

  const validStatuses = ['draft', 'sent', 'accepted', 'rejected', 'expired']
  if (status && !validStatuses.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
  }

  // Fetch user invoices or quotes representing quotes
  const where = {
    userId: auth.user.id,
    ...(status ? { status } : {}),
  }

  const total = await prisma.invoice.count({ where })
  const quotes = await prisma.invoice.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (page - 1) * limit,
    take: limit,
    select: {
      id: true,
      invoiceNumber: true,
      clientName: true,
      clientEmail: true,
      description: true,
      amount: true,
      currency: true,
      status: true,
      dueDate: true,
      createdAt: true,
    },
  })

  return NextResponse.json({
    quotes: quotes.map((q) => ({
      id: q.id,
      quoteNumber: q.invoiceNumber.replace('INV', 'QTE'),
      clientName: q.clientName,
      clientEmail: q.clientEmail,
      description: q.description,
      amount: Number(q.amount),
      currency: q.currency,
      status: q.status,
      validUntil: q.dueDate,
      createdAt: q.createdAt,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  })
}

export async function POST(request: NextRequest) {
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

  const { clientEmail, clientName, description, amount, currency = 'USD', validUntil } = body

  if (!clientEmail || !description || amount === undefined || amount === null) {
    return NextResponse.json(
      { error: 'clientEmail, description, and amount are required' },
      { status: 400 },
    )
  }

  if (typeof clientEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail.trim())) {
    return NextResponse.json({ error: 'clientEmail must be a valid email address' }, { status: 400 })
  }

  if (typeof description !== 'string' || description.trim() === '') {
    return NextResponse.json({ error: 'description must be a non-empty string' }, { status: 400 })
  }

  const parsedAmount = Number(amount)
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
  }

  let parsedValidUntil: Date | null = null
  if (validUntil) {
    if (typeof validUntil !== 'string') {
      return NextResponse.json({ error: 'validUntil must be a valid date string' }, { status: 400 })
    }
    parsedValidUntil = new Date(validUntil)
    if (Number.isNaN(parsedValidUntil.getTime())) {
      return NextResponse.json({ error: 'validUntil must be a valid date string' }, { status: 400 })
    }
  }

  const quoteId = `qte_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
  const quoteNumber = `QTE-${Date.now().toString().slice(-6)}`

  return NextResponse.json(
    {
      id: quoteId,
      quoteNumber,
      clientEmail: (clientEmail as string).trim().toLowerCase(),
      clientName: typeof clientName === 'string' ? clientName.trim() : null,
      description: (description as string).trim(),
      amount: parsedAmount,
      currency: String(currency),
      status: 'draft',
      validUntil: parsedValidUntil,
      createdAt: new Date().toISOString(),
    },
    { status: 201 },
  )
}
