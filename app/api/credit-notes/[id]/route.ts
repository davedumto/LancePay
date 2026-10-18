import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

/**
 * GET /api/credit-notes/[id]
 *
 * Fetches a single credit note owned by the authenticated user along with:
 * - `appliedAmount`: running total already allocated to invoices
 * - `remainingBalance`: computed as `amount - appliedAmount` per the schema invariant
 * - `applications`: list of `CreditNoteApplication` rows applied against this credit note
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    const { id } = await Promise.resolve(params)
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const creditNote = await prisma.creditNote.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        invoiceId: true,
        creditNumber: true,
        amount: true,
        appliedAmount: true,
        currency: true,
        reason: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        applications: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            invoiceId: true,
            amount: true,
            createdAt: true,
          },
        },
      },
    })

    if (!creditNote) {
      return NextResponse.json({ error: 'Credit note not found' }, { status: 404 })
    }

    if (creditNote.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const totalAmount = new Decimal(creditNote.amount.toString())
    const appliedAmount = new Decimal((creditNote.appliedAmount ?? 0).toString())
    const remainingBalance = Decimal.max(new Decimal(0), totalAmount.minus(appliedAmount))

    return NextResponse.json({
      creditNote: {
        id: creditNote.id,
        invoiceId: creditNote.invoiceId,
        creditNumber: creditNote.creditNumber,
        amount: totalAmount.toNumber(),
        appliedAmount: appliedAmount.toNumber(),
        remainingBalance: remainingBalance.toNumber(),
        currency: creditNote.currency,
        reason: creditNote.reason,
        status: creditNote.status,
        createdAt: creditNote.createdAt.toISOString(),
        ...(creditNote.updatedAt ? { updatedAt: creditNote.updatedAt.toISOString() } : {}),
        applications: (creditNote.applications ?? []).map((app) => ({
          id: app.id,
          invoiceId: app.invoiceId,
          amount: Number(app.amount),
          createdAt: app.createdAt.toISOString(),
        })),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/credit-notes/[id] error')
    return NextResponse.json({ error: 'Failed to fetch credit note' }, { status: 500 })
  }
}
