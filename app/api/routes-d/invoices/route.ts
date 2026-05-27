import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { generateInvoiceNumber } from '@/lib/utils'
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
    const status = searchParams.get('status') ?? undefined
    const cursor = searchParams.get('cursor') ?? undefined
    const limitParam = searchParams.get('limit')

    const VALID_STATUSES = ['pending', 'paid', 'overdue', 'cancelled']
    if (status && !VALID_STATUSES.includes(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 },
      )
    }

    const limit = Math.min(
      limitParam ? Math.max(1, parseInt(limitParam, 10) || DEFAULT_LIMIT) : DEFAULT_LIMIT,
      MAX_LIMIT,
    )

    const invoices = await prisma.invoice.findMany({
      where: {
        userId: user.id,
        ...(status ? { status } : {}),
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
        status: true,
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
    logger.error({ err: error }, 'GET /api/routes-d/invoices error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}

type CreateInvoiceBody = {
  clientEmail?: unknown
  clientName?: unknown
  description?: unknown
  amount?: unknown
  currency?: unknown
  dueDate?: unknown
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: CreateInvoiceBody
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { clientEmail, clientName, description, amount, currency = 'USD', dueDate } = body

    if (typeof clientEmail !== 'string' || !clientEmail.trim()) {
      return NextResponse.json({ error: 'clientEmail is required' }, { status: 400 })
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(clientEmail.trim())) {
      return NextResponse.json({ error: 'clientEmail must be a valid email' }, { status: 400 })
    }

    if (typeof description !== 'string' || !description.trim()) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }
    if (description.length > 500) {
      return NextResponse.json(
        { error: 'description must be 500 characters or fewer' },
        { status: 400 },
      )
    }

    const parsedAmount = Number(amount)
    if (amount == null || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }

    if (typeof currency !== 'string') {
      return NextResponse.json({ error: 'currency must be a string' }, { status: 400 })
    }

    let parsedDueDate: Date | null = null
    if (dueDate !== undefined && dueDate !== null) {
      if (typeof dueDate !== 'string') {
        return NextResponse.json(
          { error: 'dueDate must be a valid ISO date string' },
          { status: 400 },
        )
      }
      const d = new Date(dueDate)
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json(
          { error: 'dueDate must be a valid ISO date string' },
          { status: 400 },
        )
      }
      parsedDueDate = d
    }

    const normalizedEmail = clientEmail.trim().toLowerCase()
    const normalizedCurrency = String(currency).toUpperCase()
    const invoiceNumber = generateInvoiceNumber()

    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`
    const paymentLink = `${baseUrl}/pay/${invoiceNumber}`

    const invoice = await prisma.invoice.create({
      data: {
        userId: user.id,
        invoiceNumber,
        clientEmail: normalizedEmail,
        clientName: typeof clientName === 'string' ? clientName.trim() || null : null,
        description: description.trim(),
        amount: parsedAmount,
        currency: normalizedCurrency,
        paymentLink,
        dueDate: parsedDueDate,
      },
      select: {
        id: true,
        invoiceNumber: true,
        paymentLink: true,
        status: true,
        amount: true,
        currency: true,
        clientEmail: true,
        clientName: true,
        description: true,
        dueDate: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      { ...invoice, amount: Number(invoice.amount) },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/invoices error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
