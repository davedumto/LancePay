import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET  /api/credit-notes — list the authenticated user's credit notes.
 * POST /api/credit-notes — issue a credit note against one of their invoices.
 */

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const VALID_STATUSES = ['issued', 'applied', 'voided'] as const
const MAX_CREDIT_NUMBER_RETRIES = 3

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return { error: 'Unauthorized', status: 401 as const }
  const claims = await verifyAuthToken(authToken)
  if (!claims) return { error: 'Invalid token', status: 401 as const }
  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  if (!user) return { error: 'User not found', status: 404 as const }
  return { user }
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

export function generateCreditNumber(): string {
  const stamp = Date.now().toString(36).toUpperCase()
  const rand = randomBytes(4).toString('hex').toUpperCase()
  return `CN-${stamp}-${rand}`
}

function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as any).code === 'P2002'
}

function serializeCreditNote(row: any) {
  const amount = new Decimal(row.amount.toString())
  const appliedAmount = new Decimal((row.appliedAmount ?? 0).toString())
  const remainingBalance = Decimal.max(new Decimal(0), amount.minus(appliedAmount))

  return {
    id: row.id,
    invoiceId: row.invoiceId,
    creditNumber: row.creditNumber,
    amount: amount.toNumber(),
    appliedAmount: appliedAmount.toNumber(),
    remainingBalance: remainingBalance.toNumber(),
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }
    const { user } = auth

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const invoiceId = searchParams.get('invoiceId')?.trim() || undefined
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
      ...(invoiceId ? { invoiceId } : {}),
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
          appliedAmount: true,
          currency: true,
          reason: true,
          status: true,
          createdAt: true,
        },
      }),
    ])

    return NextResponse.json({
      creditNotes: creditNotes.map(serializeCreditNote),
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
    const auth = await getAuthenticatedUser(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status })
    }
    const { user } = auth

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

    let createdCreditNote: any = null
    for (let attempt = 0; attempt < MAX_CREDIT_NUMBER_RETRIES; attempt++) {
      try {
        createdCreditNote = await prisma.creditNote.create({
          data: {
            userId: user.id,
            invoiceId: invoice.id,
            creditNumber: generateCreditNumber(),
            amount: parsedAmount,
            appliedAmount: 0,
            currency: invoice.currency,
            reason: reason.trim(),
            status: 'issued',
          },
          select: {
            id: true,
            invoiceId: true,
            creditNumber: true,
            amount: true,
            appliedAmount: true,
            currency: true,
            reason: true,
            status: true,
            createdAt: true,
          },
        })
        break
      } catch (err) {
        if (isUniqueConstraintError(err) && attempt < MAX_CREDIT_NUMBER_RETRIES - 1) {
          continue
        }
        throw err
      }
    }

    return NextResponse.json(
      {
        creditNote: serializeCreditNote(createdCreditNote),
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/credit-notes error')
    return NextResponse.json({ error: 'Failed to create credit note' }, { status: 500 })
  }
}
