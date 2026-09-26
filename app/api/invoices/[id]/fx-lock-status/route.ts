import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { convertAmount, findFxRate, serializeFxRate } from '@/lib/fx-rates'
import { isFxLockExpired, serializeFxLock } from '@/lib/invoice-fx-lock'

// GET /api/invoices/[id]/fx-lock-status — whether the invoice's latest FX lock
// is still within its validity window.
//
// status is "not_locked" (no lock was ever taken), "active" or "expired",
// with an explicit expired boolean (null when not locked). An expired lock is
// reported alongside the current rate from FxRateSnapshot, applied to the
// amount that was locked, for comparison. This is a read: observing an
// expired lock does not change it.

export async function GET(
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
      select: { id: true },
    })
    if (!invoice) {
      return NextResponse.json({ error: 'Invoice not found', code: 'INVOICE_NOT_FOUND' }, { status: 404 })
    }

    const lock = await prisma.invoiceFxLock.findFirst({
      where: { invoiceId: invoice.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { fxRateSnapshot: true },
    })

    if (!lock) {
      return NextResponse.json({
        invoiceId: invoice.id,
        status: 'not_locked',
        locked: false,
        expired: null,
        lock: null,
        currentRate: null,
      })
    }

    const now = new Date()
    if (!isFxLockExpired(lock.expiresAt, now)) {
      return NextResponse.json({
        invoiceId: invoice.id,
        status: 'active',
        locked: true,
        expired: false,
        lock: serializeFxLock(lock),
        currentRate: null,
      })
    }

    const current = await findFxRate(lock.sourceCurrency, lock.lockedCurrency, now)
    if (!current) {
      return NextResponse.json(
        {
          error: `No ${lock.sourceCurrency}/${lock.lockedCurrency} exchange rate is available`,
          code: 'FX_RATE_UNAVAILABLE',
        },
        { status: 422 },
      )
    }
    const currentAmount = convertAmount(lock.sourceAmount, current)

    return NextResponse.json({
      invoiceId: invoice.id,
      status: 'expired',
      locked: true,
      expired: true,
      lock: serializeFxLock(lock),
      currentRate: {
        ...serializeFxRate(current),
        amount: currentAmount.toFixed(2),
        currency: lock.lockedCurrency,
        differenceFromLocked: currentAmount.minus(lock.lockedAmount).toFixed(2),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/invoices/[id]/fx-lock-status error')
    return NextResponse.json({ error: 'Failed to fetch FX lock status' }, { status: 500 })
  }
}
