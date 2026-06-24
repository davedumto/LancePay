import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET  /api/routes-d/transfers — list the authenticated user's transfers ──
// ── POST /api/routes-d/transfers — initiate a peer-to-peer transfer ──
//
// "Transfer" is a peer-to-peer Transaction of type "transfer".
// The existing Transaction model is the backing store.

const MAX_AMOUNT = 1_000_000

type TransactionDelegate = {
  findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>
  create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function getTxDelegate(): TransactionDelegate {
  return (prisma as unknown as { transaction: TransactionDelegate }).transaction
}

function decimalToString(value: unknown): string {
  if (value === null || value === undefined) return '0'
  if (typeof (value as { toString?: () => string })?.toString === 'function') {
    return (value as { toString: () => string }).toString()
  }
  return String(value)
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { searchParams } = new URL(request.url)
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10) || 20))

    const transfers = await getTxDelegate().findMany({
      where: { userId: user.id, type: 'transfer' },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        externalId: true,
        createdAt: true,
        completedAt: true,
      },
    })

    const serialized = transfers.map((t) => ({
      ...t,
      amount: decimalToString((t as { amount: unknown }).amount),
    }))

    return NextResponse.json({ transfers: serialized, page, limit })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/transfers error')
    return NextResponse.json({ error: 'Failed to list transfers' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = (await request.json().catch(() => null)) as
      | { recipientId?: string; amount?: number; currency?: string; note?: string }
      | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

    const { recipientId, amount, currency, note } = body

    if (!recipientId || typeof recipientId !== 'string') {
      return NextResponse.json({ error: 'recipientId is required' }, { status: 400 })
    }
    if (recipientId === user.id) {
      return NextResponse.json({ error: 'Cannot transfer to yourself' }, { status: 400 })
    }

    const recipient = await prisma.user.findUnique({ where: { id: recipientId }, select: { id: true } })
    if (!recipient) {
      return NextResponse.json({ error: 'Recipient not found' }, { status: 404 })
    }

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'amount must be a positive number' }, { status: 400 })
    }
    if (amount > MAX_AMOUNT) {
      return NextResponse.json({ error: `amount must not exceed ${MAX_AMOUNT}` }, { status: 400 })
    }

    const resolvedCurrency = (typeof currency === 'string' && currency.trim()) ? currency.trim().toUpperCase() : 'USD'
    if (!/^[A-Z]{3,5}$/.test(resolvedCurrency)) {
      return NextResponse.json({ error: 'currency must be a 3–5 letter code' }, { status: 400 })
    }

    const transfer = await getTxDelegate().create({
      data: {
        userId: user.id,
        type: 'transfer',
        status: 'pending',
        amount: amount.toString(),
        currency: resolvedCurrency,
        externalId: `transfer-${user.id}-${recipientId}-${Date.now()}`,
        ...(typeof note === 'string' && note.trim() ? { error: null } : {}),
      },
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        currency: true,
        externalId: true,
        createdAt: true,
      },
    })

    return NextResponse.json(
      {
        transfer: {
          ...transfer,
          amount: decimalToString((transfer as { amount: unknown }).amount),
        },
      },
      { status: 201 },
    )
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/transfers error')
    return NextResponse.json({ error: 'Failed to initiate transfer' }, { status: 500 })
  }
}
