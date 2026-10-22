import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET  /api/credit-notes — list the authenticated user's credit notes.
// POST /api/credit-notes — issue a credit note against one of their invoices.
//
// GET query params (all optional):
//   status — filter by credit note status (issued | applied | voided)
//   page   — 1-based page number (default: 1)
//   limit  — page size 1–100 (default: 25)

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const VALID_STATUSES = ['issued', 'applied', 'voided'] as const

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

function parsePage(raw: string | null): number {
  if (!raw) return 1
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

function generateCreditNumber(): string {
  const stamp = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `CN-${stamp}-${rand}`
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const page = parsePage(searchParams.get('page'))
    const limit = parseLimit(searchParams.get('limit'))

    if (status && !(VALID_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
        { status: 400 },
      )
    }

    const where = {
      userId: user.id,
      ...(status ? { status } : {}),
    }

    const [total, creditNotes] = await Promise.all([
      prisma.creditNote.count({ where }),
      prisma.creditNote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          invoiceId: true,
          creditNumber: true,
          amount: true,
          currency: true,
          reason: true,
          status: true,
          createdAt: true,
        },
      }),
    ])

    return NextResponse.json({
      creditNotes: creditNotes.map((c) => ({
        ...c,
        amount: Number(c.amount),
        createdAt: c.createdAt.toISOString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/credit-notes error')
    return NextResponse.json({ error: 'Failed to fetch credit notes' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as Record<string, unknown>
    const { invoiceId, amount, reason } = payload

    if (typeof invoiceId !== 'string' || !invoiceId.trim()) {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 })
    }

    if (typeof reason !== 'string' || !reason.trim()) {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 })
    }

    const parsedAmount = Number(amount)
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }

    // Validate invoiceId belongs to the authenticated user
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId.trim(), userId: user.id },
      select: { id: true, amount: true, currency: true },
    })

    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (parsedAmount > Number(invoice.amount)) {
      return NextResponse.json(
        { error: 'amount cannot exceed the invoice total' },
        { status: 400 },
      )
    }

    const creditNote = await prisma.creditNote.create({
      data: {
        userId: user.id,
        invoiceId: invoice.id,
        creditNumber: generateCreditNumber(),
        amount: parsedAmount,
        currency: invoice.currency,
        reason: reason.trim(),
        status: 'issued',
      },
      select: {
        id: true,
        invoiceId: true,
        creditNumber: true,
        amount: true,
        currency: true,
        reason: true,
        status: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      {
        creditNote: {
          ...creditNote,
          amount: Number(creditNote.amount),
          createdAt: creditNote.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/credit-notes error')
    return NextResponse.json({ error: 'Failed to create credit note' }, { status: 500 })
  }
}
