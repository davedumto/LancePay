import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

/**
 * A "transfer" in this API is one row in the underlying `Transaction`
 * table — that is the canonical record of money moving through
 * LancePay. The dedicated `transfers/[id]` route keeps the public
 * surface aligned with how the product describes the entity, without
 * forcing a rename of the existing internal model.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type RouteContext = {
  params: Promise<{ id: string }> | { id: string }
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')

  if (!claims) {
    return null
  }

  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

function decimalToString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof (value as { toString?: () => string })?.toString === 'function') {
    return (value as { toString: () => string }).toString()
  }
  return String(value)
}

async function resolveParams(context: RouteContext): Promise<{ id: string }> {
  const raw = context.params as { id: string } | Promise<{ id: string }>
  if (raw && typeof (raw as Promise<{ id: string }>).then === 'function') {
    return raw as Promise<{ id: string }>
  }
  return raw as { id: string }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const user = await getAuthenticatedUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await resolveParams(context)

  if (!id || !UUID_PATTERN.test(id)) {
    return NextResponse.json(
      { error: 'Transfer id must be a UUID.' },
      { status: 400 },
    )
  }

  // findFirst() with both id and userId so a caller cannot probe for
  // transfer ids that exist but belong to someone else — they get a
  // uniform 404.
  const transfer = await prisma.transaction.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true,
      type: true,
      status: true,
      amount: true,
      currency: true,
      ngnAmount: true,
      exchangeRate: true,
      invoiceId: true,
      bankAccountId: true,
      txHash: true,
      externalId: true,
      virtualAccountId: true,
      autoSwapTriggered: true,
      error: true,
      createdAt: true,
      completedAt: true,
    },
  })

  if (!transfer) {
    return NextResponse.json({ error: 'Transfer not found' }, { status: 404 })
  }

  return NextResponse.json({
    id: transfer.id,
    type: transfer.type,
    status: transfer.status,
    amount: decimalToString(transfer.amount),
    currency: transfer.currency,
    ngnAmount: decimalToString(transfer.ngnAmount),
    exchangeRate: decimalToString(transfer.exchangeRate),
    invoiceId: transfer.invoiceId ?? null,
    bankAccountId: transfer.bankAccountId ?? null,
    txHash: transfer.txHash ?? null,
    externalId: transfer.externalId ?? null,
    virtualAccountId: transfer.virtualAccountId ?? null,
    autoSwapTriggered: transfer.autoSwapTriggered,
    error: transfer.error ?? null,
    createdAt: transfer.createdAt,
    completedAt: transfer.completedAt ?? null,
  })
}
