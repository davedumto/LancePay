import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { extractRequestMetadata, logAuditEvent } from '@/lib/audit'
import { logger } from '@/lib/logger'
import { convertAmount, findFxRate } from '@/lib/fx-rates'
import {
  FX_LOCK_TARGET_CURRENCY,
  fxLockMaxSnapshotAgeMs,
  fxLockTtlMs,
  serializeFxLock,
} from '@/lib/invoice-fx-lock'

// POST /api/invoices/[id]/lock-fx-rate — freeze the latest FxRateSnapshot for
// the invoice currency -> NGN against one of the owner's open invoices.
//
// The lock records the snapshot it used, the invoice amount at that moment
// and the NGN amount it produced, and expires after the configured TTL
// (INVOICE_FX_LOCK_TTL_MINUTES). The request body is ignored: neither the
// rate nor the expiry can be chosen by the caller.
//
// Idempotent while a lock is active: calling again returns the current lock
// (200) instead of creating a second one. Once it has expired a new lock is
// created (201) and the old one stays as history.
//
// Concurrency: the invoice row is locked (SELECT ... FOR UPDATE) for the
// status re-check and the insert, so a payment marking the invoice paid and a
// concurrent lock request are serialized, and two lock requests cannot both
// create an active lock.

const OPEN_INVOICE_STATUSES = ['pending', 'overdue']

class LockError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

function errorJson(error: LockError) {
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      ...(Object.keys(error.details).length ? { details: error.details } : {}),
    },
    { status: error.status },
  )
}

function assertLockable(status: string) {
  if (status === 'paid') {
    throw new LockError(409, 'INVOICE_ALREADY_PAID', 'Cannot lock an exchange rate on a paid invoice')
  }
  if (!OPEN_INVOICE_STATUSES.includes(status)) {
    throw new LockError(422, 'INVOICE_NOT_OPEN', `Cannot lock an exchange rate on a ${status} invoice`)
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params

    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const invoice = await prisma.invoice.findFirst({
      where: { id, userId: user.id },
      select: { id: true, currency: true, status: true },
    })
    if (!invoice) throw new LockError(404, 'INVOICE_NOT_FOUND', 'Invoice not found')
    assertLockable(invoice.status)

    const sourceCurrency = invoice.currency.toUpperCase()
    if (sourceCurrency === FX_LOCK_TARGET_CURRENCY) {
      throw new LockError(
        422,
        'FX_LOCK_NOT_APPLICABLE',
        `Invoice is already in ${FX_LOCK_TARGET_CURRENCY}; there is no rate to lock`,
      )
    }

    const now = new Date()
    const resolved = await findFxRate(sourceCurrency, FX_LOCK_TARGET_CURRENCY, now)
    if (!resolved?.snapshot) {
      throw new LockError(
        422,
        'FX_RATE_UNAVAILABLE',
        `No ${sourceCurrency}/${FX_LOCK_TARGET_CURRENCY} exchange rate is available`,
      )
    }
    const snapshotAgeMs = now.getTime() - resolved.snapshot.capturedAt.getTime()
    if (snapshotAgeMs > fxLockMaxSnapshotAgeMs()) {
      throw new LockError(
        422,
        'FX_RATE_STALE',
        `The latest ${sourceCurrency}/${FX_LOCK_TARGET_CURRENCY} exchange rate is too old to lock`,
        { capturedAt: resolved.snapshot.capturedAt.toISOString() },
      )
    }
    const snapshot = resolved.snapshot

    const auditMetadata = extractRequestMetadata(request.headers)

    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; amount: Decimal; currency: string }[]>`
        SELECT "status", "amount", "currency"
        FROM "Invoice"
        WHERE "id" = ${invoice.id} AND "userId" = ${user.id}
        FOR UPDATE
      `
      const current = rows[0]
      if (!current) throw new LockError(404, 'INVOICE_NOT_FOUND', 'Invoice not found')
      assertLockable(current.status)
      if (current.currency.toUpperCase() !== sourceCurrency) {
        throw new LockError(409, 'INVOICE_CHANGED', 'Invoice currency changed while locking; try again')
      }

      const active = await tx.invoiceFxLock.findFirst({
        where: { invoiceId: invoice.id, expiresAt: { gt: now } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { fxRateSnapshot: true },
      })
      if (active) return { lock: active, created: false }

      const sourceAmount = new Decimal(current.amount)
      const lock = await tx.invoiceFxLock.create({
        data: {
          invoiceId: invoice.id,
          fxRateSnapshotId: snapshot.id,
          inverted: resolved.inverted,
          sourceAmount,
          sourceCurrency,
          lockedAmount: convertAmount(sourceAmount, resolved),
          lockedCurrency: FX_LOCK_TARGET_CURRENCY,
          lockedBy: user.id,
          expiresAt: new Date(now.getTime() + fxLockTtlMs()),
          createdAt: now,
        },
        include: { fxRateSnapshot: true },
      })

      await logAuditEvent(
        invoice.id,
        'invoice.fx_rate_locked',
        user.id,
        {
          ...auditMetadata,
          fxLockId: lock.id,
          fxRateSnapshotId: snapshot.id,
          inverted: lock.inverted,
          sourceAmount: lock.sourceAmount.toString(),
          lockedAmount: lock.lockedAmount.toString(),
          expiresAt: lock.expiresAt.toISOString(),
        },
        tx,
      )

      return { lock, created: true }
    })

    return NextResponse.json(
      { lock: serializeFxLock(result.lock), created: result.created },
      { status: result.created ? 201 : 200 },
    )
  } catch (error) {
    if (error instanceof LockError) return errorJson(error)
    logger.error({ err: error }, 'POST /api/invoices/[id]/lock-fx-rate error')
    return NextResponse.json({ error: 'Failed to lock exchange rate' }, { status: 500 })
  }
}
