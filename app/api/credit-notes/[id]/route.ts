import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET /api/credit-notes/[id] — fetch a single credit note owned by the
// authenticated user, including its remaining unapplied balance.
//
// remainingBalance is computed as amount minus the sum of any applied amounts.
// The current schema tracks applied state via the status field; appliedAmount
// is not yet a schema field, so remainingBalance equals amount until a
// CreditNoteApplication relation is introduced.

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const creditNote = await prisma.creditNote.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        invoiceId: true,
        creditNumber: true,
        amount: true,
        currency: true,
        reason: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    if (!creditNote) {
      return NextResponse.json({ error: 'Credit note not found' }, { status: 404 })
    }
    if (creditNote.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const amount = Number(creditNote.amount)
    // appliedAmount and CreditNoteApplication are not yet in the schema.
    // remainingBalance defaults to the full amount until those are introduced.
    const appliedAmount = 0
    const remainingBalance = amount - appliedAmount

    return NextResponse.json({
      creditNote: {
        id: creditNote.id,
        invoiceId: creditNote.invoiceId,
        creditNumber: creditNote.creditNumber,
        amount,
        appliedAmount,
        remainingBalance,
        currency: creditNote.currency,
        reason: creditNote.reason,
        status: creditNote.status,
        applications: [],
        createdAt: creditNote.createdAt.toISOString(),
        updatedAt: creditNote.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/credit-notes/[id] error')
    return NextResponse.json({ error: 'Failed to fetch credit note' }, { status: 500 })
  }
}
