import { NextRequest, NextResponse } from 'next/server'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { extractRequestMetadata, logAuditEvent } from '@/lib/audit'
import { logger } from '@/lib/logger'
import { parsePositiveMoney } from '@/lib/money'

// POST /api/credit-notes/[id]/apply — allocate a credit note's remaining
// balance across one or more of the owner's open invoices.
//
// Body: { allocations: [{ invoiceId, amount }, ...] }
//
// Each allocation reduces the invoice's amount due (Invoice.amount, as the
// retainer credit flow does) and is recorded as a CreditNoteApplication. An
// invoice reduced to zero is marked paid. The whole request is atomic: if any
// allocation fails, nothing is applied.
//
// Concurrency: the credit note balance is debited with a single conditional
// UPDATE (appliedAmount + total <= amount) inside the transaction, so two
// requests racing for the same credit note cannot both succeed beyond its
// balance; the loser gets 409. A CHECK constraint enforces the same invariant
// in the database. Invoice debits are equally conditional on the invoice
// still being open with enough balance.

const MAX_ALLOCATIONS = 50
const OPEN_INVOICE_STATUSES = ['pending', 'overdue']

interface ParsedAllocation {
  invoiceId: string
  amount: Decimal
}

class CreditApplicationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

function errorJson(error: CreditApplicationError) {
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      ...(Object.keys(error.details).length ? { details: error.details } : {}),
    },
    { status: error.status },
  )
}

function parseAllocations(body: unknown): ParsedAllocation[] {
  const raw = (body ?? {}) as Record<string, unknown>
  const allocations = raw.allocations

  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw new CreditApplicationError(400, 'VALIDATION_ERROR', 'allocations must be a non-empty array')
  }
  if (allocations.length > MAX_ALLOCATIONS) {
    throw new CreditApplicationError(
      400,
      'VALIDATION_ERROR',
      `allocations cannot contain more than ${MAX_ALLOCATIONS} entries`,
    )
  }

  const seen = new Set<string>()
  return allocations.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>
    if (typeof item.invoiceId !== 'string' || !item.invoiceId.trim()) {
      throw new CreditApplicationError(400, 'VALIDATION_ERROR', `allocations[${index}].invoiceId is required`)
    }
    const invoiceId = item.invoiceId.trim()

    const amount = parsePositiveMoney(item.amount)
    if (!amount) {
      throw new CreditApplicationError(
        400,
        'VALIDATION_ERROR',
        `allocations[${index}].amount must be a positive amount with at most 2 decimal places`,
      )
    }

    if (seen.has(invoiceId)) {
      throw new CreditApplicationError(
        400,
        'DUPLICATE_INVOICE',
        'Each invoice may appear only once per request',
        { invoiceId },
      )
    }
    seen.add(invoiceId)

    return { invoiceId, amount }
  })
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

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const allocations = parseAllocations(body)
    const total = allocations.reduce((sum, a) => sum.plus(a.amount), new Decimal(0))

    const creditNote = await prisma.creditNote.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        creditNumber: true,
        amount: true,
        appliedAmount: true,
        currency: true,
        status: true,
        invoice: { select: { clientEmail: true } },
      },
    })

    if (!creditNote) {
      return NextResponse.json({ error: 'Credit note not found' }, { status: 404 })
    }

    const remainingBefore = creditNote.amount.minus(creditNote.appliedAmount)

    if (creditNote.status === 'voided') {
      throw new CreditApplicationError(422, 'CREDIT_NOTE_VOIDED', 'A voided credit note cannot be applied')
    }
    if (creditNote.status === 'applied' || remainingBefore.lte(0)) {
      throw new CreditApplicationError(409, 'CREDIT_NOTE_FULLY_APPLIED', 'Credit note has already been fully applied')
    }
    if (creditNote.status !== 'issued') {
      throw new CreditApplicationError(
        422,
        'CREDIT_NOTE_NOT_APPLICABLE',
        `Credit note with status "${creditNote.status}" cannot be applied`,
      )
    }
    if (total.gt(remainingBefore)) {
      throw new CreditApplicationError(
        422,
        'INSUFFICIENT_CREDIT_BALANCE',
        'Total requested exceeds the credit note remaining balance',
        { requested: total.toNumber(), remainingBalance: remainingBefore.toNumber() },
      )
    }

    const invoices = await prisma.invoice.findMany({
      where: { id: { in: allocations.map((a) => a.invoiceId) }, userId: user.id },
      select: { id: true, amount: true, currency: true, status: true, clientEmail: true },
    })
    const invoicesById = new Map(invoices.map((invoice) => [invoice.id, invoice]))
    const creditClient = creditNote.invoice.clientEmail.toLowerCase()

    for (const allocation of allocations) {
      const invoice = invoicesById.get(allocation.invoiceId)
      const details = { invoiceId: allocation.invoiceId }
      if (!invoice) {
        throw new CreditApplicationError(404, 'INVOICE_NOT_FOUND', 'Invoice not found', details)
      }
      if (!OPEN_INVOICE_STATUSES.includes(invoice.status)) {
        throw new CreditApplicationError(
          422,
          'INVOICE_NOT_OPEN',
          `Credit cannot be applied to a ${invoice.status} invoice`,
          details,
        )
      }
      if (invoice.currency !== creditNote.currency) {
        throw new CreditApplicationError(
          422,
          'CURRENCY_MISMATCH',
          'Invoice currency does not match the credit note currency',
          details,
        )
      }
      if (invoice.clientEmail.toLowerCase() !== creditClient) {
        throw new CreditApplicationError(
          422,
          'INVOICE_CLIENT_MISMATCH',
          'Credit can only be applied to invoices of the same client',
          details,
        )
      }
      if (allocation.amount.gt(invoice.amount)) {
        throw new CreditApplicationError(
          422,
          'ALLOCATION_EXCEEDS_INVOICE_BALANCE',
          'Allocation exceeds the invoice balance',
          { ...details, invoiceBalance: invoice.amount.toNumber() },
        )
      }
    }

    const now = new Date()
    const auditMetadata = extractRequestMetadata(request.headers)

    const result = await prisma.$transaction(async (tx) => {
      const debited = await tx.$queryRaw<{ amount: Decimal; appliedAmount: Decimal; status: string }[]>`
        UPDATE "CreditNote"
        SET "appliedAmount" = "appliedAmount" + ${total},
            "status" = CASE WHEN "appliedAmount" + ${total} = "amount" THEN 'applied' ELSE "status" END,
            "updatedAt" = ${now}
        WHERE "id" = ${creditNote.id}
          AND "userId" = ${user.id}
          AND "status" = 'issued'
          AND "appliedAmount" + ${total} <= "amount"
        RETURNING "amount", "appliedAmount", "status"
      `
      if (debited.length !== 1) {
        throw new CreditApplicationError(
          409,
          'CREDIT_NOTE_BALANCE_CHANGED',
          'Credit note balance changed while applying; not enough credit remains',
        )
      }

      // Lock invoices in a stable order to avoid deadlocks between concurrent requests.
      const ordered = [...allocations].sort((a, b) => a.invoiceId.localeCompare(b.invoiceId))
      const applied = new Map<string, { applicationId: string; balance: Decimal; status: string }>()

      for (const allocation of ordered) {
        const debit = await tx.invoice.updateMany({
          where: {
            id: allocation.invoiceId,
            userId: user.id,
            status: { in: OPEN_INVOICE_STATUSES },
            currency: creditNote.currency,
            amount: { gte: allocation.amount },
          },
          data: { amount: { decrement: allocation.amount } },
        })
        if (debit.count !== 1) {
          throw new CreditApplicationError(
            409,
            'INVOICE_CHANGED',
            'Invoice changed while applying credit; nothing was applied',
            { invoiceId: allocation.invoiceId },
          )
        }

        let invoice = await tx.invoice.findUniqueOrThrow({
          where: { id: allocation.invoiceId },
          select: { amount: true, status: true },
        })
        if (invoice.amount.isZero()) {
          invoice = await tx.invoice.update({
            where: { id: allocation.invoiceId },
            data: { status: 'paid', paidAt: now },
            select: { amount: true, status: true },
          })
        }

        const application = await tx.creditNoteApplication.create({
          data: {
            creditNoteId: creditNote.id,
            invoiceId: allocation.invoiceId,
            amount: allocation.amount,
          },
          select: { id: true },
        })

        await logAuditEvent(
          allocation.invoiceId,
          'invoice.credit_applied',
          user.id,
          {
            ...auditMetadata,
            creditNoteId: creditNote.id,
            creditNumber: creditNote.creditNumber,
            amount: allocation.amount.toString(),
          },
          tx,
        )

        applied.set(allocation.invoiceId, {
          applicationId: application.id,
          balance: invoice.amount,
          status: invoice.status,
        })
      }

      return { creditNote: debited[0], applied }
    })

    const finalAmount = result.creditNote.amount
    const finalApplied = result.creditNote.appliedAmount
    const finalRemaining = finalAmount.minus(finalApplied)

    // Derived from the committed balance, not the pre-transaction read, so it
    // stays correct when other requests applied credit in between.
    let runningBalance = finalRemaining.plus(total)
    const responseAllocations = allocations.map((allocation) => {
      const outcome = result.applied.get(allocation.invoiceId)
      runningBalance = runningBalance.minus(allocation.amount)
      return {
        applicationId: outcome?.applicationId,
        invoiceId: allocation.invoiceId,
        amount: allocation.amount.toNumber(),
        creditRemainingAfter: runningBalance.toNumber(),
        invoiceBalance: outcome?.balance.toNumber(),
        invoiceStatus: outcome?.status,
      }
    })

    return NextResponse.json(
      {
        creditNote: {
          id: creditNote.id,
          creditNumber: creditNote.creditNumber,
          currency: creditNote.currency,
          amount: finalAmount.toNumber(),
          appliedAmount: finalApplied.toNumber(),
          remainingBalance: finalRemaining.toNumber(),
          status: result.creditNote.status,
        },
        totalApplied: total.toNumber(),
        allocations: responseAllocations,
      },
      { status: 201 },
    )
  } catch (error) {
    if (error instanceof CreditApplicationError) return errorJson(error)
    logger.error({ err: error }, 'POST /api/credit-notes/[id]/apply error')
    return NextResponse.json({ error: 'Failed to apply credit note' }, { status: 500 })
  }
}
