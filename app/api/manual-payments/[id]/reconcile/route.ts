import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { extractRequestMetadata, logAuditEvent } from '@/lib/audit'
import { logger } from '@/lib/logger'
import {
  calendarDate,
  calendarDaysApart,
  getReconciliationTolerance,
} from '@/lib/manual-payment-reconciliation'

// POST /api/manual-payments/[id]/reconcile — match one of the owner's manual
// payments to an imported bank statement line and mark it reconciled.
//
// Body: { bankStatementLineId }
//
// The line must be in the payment's currency, and its amount and date must be
// within the configured tolerance of the payment (see
// lib/manual-payment-reconciliation.ts). The payment date is the calendar day
// it was recorded, in the owner's time zone; bank lines carry a plain date.
//
// Concurrency: the payment is claimed with a conditional update (still
// unreconciled, still in a reconcilable status), so two racing requests
// cannot both reconcile it; the loser gets 409. ManualPayment.bankStatementLineId
// is unique, so a bank line cannot be matched to two payments either.

const RECONCILABLE_STATUSES = ['pending', 'verified']

class ReconcileError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

function errorJson(error: ReconcileError) {
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      ...(Object.keys(error.details).length ? { details: error.details } : {}),
    },
    { status: error.status },
  )
}

const alreadyReconciled = () =>
  new ReconcileError(409, 'ALREADY_RECONCILED', 'Manual payment has already been reconciled')
const lineAlreadyMatched = () =>
  new ReconcileError(
    409,
    'BANK_LINE_ALREADY_MATCHED',
    'Bank statement line is already matched to another manual payment',
  )

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
      select: { id: true, timezone: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw new ReconcileError(400, 'INVALID_BODY', 'Request body must be valid JSON')
    }
    const bankStatementLineId = (body as Record<string, unknown> | null)?.bankStatementLineId
    if (typeof bankStatementLineId !== 'string' || bankStatementLineId.trim() === '') {
      throw new ReconcileError(400, 'INVALID_BODY', 'bankStatementLineId is required')
    }

    const payment = await prisma.manualPayment.findFirst({
      where: { id, invoice: { userId: user.id } },
      select: {
        id: true,
        invoiceId: true,
        amountPaid: true,
        currency: true,
        status: true,
        reconciledAt: true,
        bankStatementLineId: true,
        createdAt: true,
      },
    })
    if (!payment) {
      throw new ReconcileError(404, 'MANUAL_PAYMENT_NOT_FOUND', 'Manual payment not found')
    }
    if (payment.reconciledAt || payment.bankStatementLineId) throw alreadyReconciled()
    if (!RECONCILABLE_STATUSES.includes(payment.status)) {
      throw new ReconcileError(
        422,
        'PAYMENT_NOT_RECONCILABLE',
        `A ${payment.status} manual payment cannot be reconciled`,
      )
    }

    const line = await prisma.bankStatementLine.findFirst({
      where: { id: bankStatementLineId, userId: user.id },
      select: {
        id: true,
        amount: true,
        currency: true,
        transactionDate: true,
        manualPayment: { select: { id: true } },
      },
    })
    if (!line) {
      throw new ReconcileError(404, 'BANK_STATEMENT_LINE_NOT_FOUND', 'Bank statement line not found')
    }
    if (line.manualPayment) throw lineAlreadyMatched()

    if (line.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      throw new ReconcileError(
        422,
        'CURRENCY_MISMATCH',
        'Bank statement line currency does not match the manual payment currency',
        { paymentCurrency: payment.currency, lineCurrency: line.currency },
      )
    }

    const tolerance = getReconciliationTolerance()
    const amountDifference = payment.amountPaid.minus(line.amount).abs()
    if (amountDifference.gt(tolerance.amount)) {
      throw new ReconcileError(
        422,
        'AMOUNT_OUTSIDE_TOLERANCE',
        'Bank statement line amount does not match the manual payment within tolerance',
        {
          paymentAmount: payment.amountPaid.toString(),
          lineAmount: line.amount.toString(),
          difference: amountDifference.toString(),
          tolerance: tolerance.amount.toString(),
        },
      )
    }

    const paymentDate = calendarDate(payment.createdAt, user.timezone)
    const lineDate = line.transactionDate.toISOString().slice(0, 10)
    const daysApart = calendarDaysApart(paymentDate, lineDate)
    if (daysApart > tolerance.days) {
      throw new ReconcileError(
        422,
        'DATE_OUTSIDE_TOLERANCE',
        'Bank statement line date does not match the manual payment within tolerance',
        { paymentDate, lineDate, daysApart, toleranceDays: tolerance.days },
      )
    }

    const now = new Date()
    const auditMetadata = extractRequestMetadata(request.headers)

    try {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.manualPayment.updateMany({
          where: {
            id: payment.id,
            reconciledAt: null,
            bankStatementLineId: null,
            status: { in: RECONCILABLE_STATUSES },
          },
          data: {
            status: 'reconciled',
            reconciledAt: now,
            reconciledBy: user.id,
            bankStatementLineId: line.id,
          },
        })
        if (claimed.count !== 1) throw alreadyReconciled()

        await logAuditEvent(
          payment.invoiceId,
          'manual_payment.reconciled',
          user.id,
          {
            ...auditMetadata,
            manualPaymentId: payment.id,
            bankStatementLineId: line.id,
            currency: payment.currency,
            paymentAmount: payment.amountPaid.toString(),
            lineAmount: line.amount.toString(),
            amountDifference: amountDifference.toString(),
            paymentDate,
            lineDate,
            daysApart,
          },
          tx,
        )
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw lineAlreadyMatched()
      }
      throw error
    }

    return NextResponse.json({
      manualPayment: {
        id: payment.id,
        invoiceId: payment.invoiceId,
        amountPaid: payment.amountPaid.toString(),
        currency: payment.currency,
        status: 'reconciled',
        reconciledAt: now.toISOString(),
        reconciledBy: user.id,
      },
      bankStatementLine: {
        id: line.id,
        amount: line.amount.toString(),
        currency: line.currency,
        transactionDate: lineDate,
      },
      match: {
        amountDifference: amountDifference.toString(),
        daysApart,
        tolerance: { amount: tolerance.amount.toString(), days: tolerance.days },
      },
    })
  } catch (error) {
    if (error instanceof ReconcileError) return errorJson(error)
    logger.error({ err: error }, 'POST /api/manual-payments/[id]/reconcile error')
    return NextResponse.json({ error: 'Failed to reconcile manual payment' }, { status: 500 })
  }
}
