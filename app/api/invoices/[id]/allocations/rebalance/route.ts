import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { extractRequestMetadata, logAuditEvent } from '@/lib/audit'
import { logger } from '@/lib/logger'

// POST /api/invoices/[id]/allocations/rebalance — recompute each
// InvoiceCollaborator's dollar allocation after a disputed line item has
// been removed from the invoice.
//
// The schema has no per-line-item dispute flag: a disputed line item is
// simply deleted by the existing line-item endpoints before this is called.
// So "the remaining, non-disputed line items" is just whatever
// InvoiceLineItem rows still exist for the invoice at the time this runs.
//
// The new invoice total is the sum of those remaining line items. Each
// collaborator's sharePercentage is a fixed contractual split that doesn't
// need to change, but the dollar amount it represents does — so we
// normalize every collaborator's relative share against the new total and
// persist the result on InvoiceCollaborator.allocatedAmount. Normalizing
// (rather than applying sharePercentage directly) is what guarantees the
// allocations sum to the new total exactly, even when shares don't add up
// to 100% (the remainder is the invoice owner's own cut, not a collaborator
// allocation, so it's excluded from the sum we're required to hit).
//
// Concurrency: the invoice row is locked (SELECT ... FOR UPDATE) so a
// payment landing mid-rebalance can't race us into rebalancing a paid
// invoice.

class RebalanceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

function errorJson(error: RebalanceError) {
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      ...(Object.keys(error.details).length ? { details: error.details } : {}),
    },
    { status: error.status },
  )
}

function assertRebalanceable(status: string) {
  if (status === 'paid') {
    throw new RebalanceError(409, 'INVOICE_ALREADY_PAID', 'Cannot rebalance allocations on an invoice that is already paid')
  }
}

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: invoiceId } = await params

    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, userId: user.id },
      select: { id: true, status: true },
    })
    if (!invoice) throw new RebalanceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found')
    assertRebalanceable(invoice.status)

    const auditMetadata = extractRequestMetadata(request.headers)

    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status" FROM "Invoice" WHERE "id" = ${invoiceId} AND "userId" = ${user.id} FOR UPDATE
      `
      const current = rows[0]
      if (!current) throw new RebalanceError(404, 'INVOICE_NOT_FOUND', 'Invoice not found')
      assertRebalanceable(current.status)

      const lineItems = await tx.invoiceLineItem.findMany({
        where: { invoiceId },
        select: { id: true, quantity: true, unitPrice: true },
      })

      const newTotal = lineItems
        .reduce((sum, item) => sum.plus(new Decimal(item.quantity).times(item.unitPrice)), new Decimal(0))
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)

      const collaborators = await tx.invoiceCollaborator.findMany({
        where: { invoiceId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, sharePercentage: true },
      })

      const totalShareWeight = collaborators.reduce(
        (sum, c) => sum.plus(c.sharePercentage),
        new Decimal(0),
      )

      const now = new Date()
      let allocated = new Decimal(0)
      const allocations: { id: string; allocatedAmount: Decimal }[] = []

      collaborators.forEach((collaborator, index) => {
        const isLast = index === collaborators.length - 1
        let amount: Decimal

        if (isLast) {
          amount = newTotal.minus(allocated)
        } else if (totalShareWeight.isZero()) {
          amount = new Decimal(0)
        } else {
          amount = newTotal
            .times(collaborator.sharePercentage)
            .dividedBy(totalShareWeight)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        }

        allocated = allocated.plus(amount)
        allocations.push({ id: collaborator.id, allocatedAmount: amount })
      })

      await Promise.all(
        allocations.map((allocation) =>
          tx.invoiceCollaborator.update({
            where: { id: allocation.id },
            data: { allocatedAmount: allocation.allocatedAmount, rebalancedAt: now },
          }),
        ),
      )

      const updatedInvoice = await tx.invoice.update({
        where: { id: invoiceId },
        data: { amount: newTotal },
        select: { id: true, amount: true, status: true },
      })

      await logAuditEvent(
        invoiceId,
        'invoice.allocations_rebalanced',
        user.id,
        {
          ...auditMetadata,
          newTotal: newTotal.toFixed(2),
          lineItemCount: lineItems.length,
          allocations: allocations.map((a) => ({ collaboratorId: a.id, amount: a.allocatedAmount.toFixed(2) })),
        },
        tx,
      )

      return { invoice: updatedInvoice, collaborators, allocations }
    })

    return NextResponse.json({
      invoice: { id: result.invoice.id, amount: new Decimal(result.invoice.amount).toFixed(2), status: result.invoice.status },
      allocations: result.allocations.map((allocation) => ({
        collaboratorId: allocation.id,
        allocatedAmount: new Decimal(allocation.allocatedAmount).toFixed(2),
      })),
    })
  } catch (error) {
    if (error instanceof RebalanceError) return errorJson(error)
    logger.error({ err: error }, 'POST /api/invoices/[id]/allocations/rebalance error')
    return NextResponse.json({ error: 'Failed to rebalance invoice allocations' }, { status: 500 })
  }
}
