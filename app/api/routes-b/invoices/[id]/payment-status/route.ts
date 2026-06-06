// GET /api/routes-b/invoices/[id]/payment-status — invoice payment
// status. Returns the invoice's current status plus a payment-state
// summary derived from the attached transaction (if any). Caller must
// own the invoice OR be a collaborator on it.
//
// Closes routes-b #697.

import { withRequestId } from '../../../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

type InvoiceStatus =
  | 'pending'
  | 'paid'
  | 'partially_paid'
  | 'overdue'
  | 'cancelled'
  | 'disputed'

interface PaymentStatusResponse {
  invoiceId: string
  status: InvoiceStatus
  /** True when status is a terminal one (`paid`, `cancelled`). */
  isTerminal: boolean
  paymentLink: string
  amountDue: number
  currency: string
  dueDate: string | null
  paidAt: string | null
  /** Transaction-derived state. Null if no transaction is attached. */
  transaction: null | {
    id: string
    status: string
    amount: number
    settledAt: string | null
  }
}

function classify(status: string): { status: InvoiceStatus; isTerminal: boolean } {
  switch (status) {
    case 'paid':
      return { status: 'paid', isTerminal: true }
    case 'cancelled':
      return { status: 'cancelled', isTerminal: true }
    case 'partially_paid':
      return { status: 'partially_paid', isTerminal: false }
    case 'overdue':
      return { status: 'overdue', isTerminal: false }
    case 'disputed':
      return { status: 'disputed', isTerminal: false }
    case 'pending':
    default:
      return { status: 'pending', isTerminal: false }
  }
}

const invoiceSelection = {
  id: true,
  status: true,
  paymentLink: true,
  amount: true,
  currency: true,
  dueDate: true,
  paidAt: true,
  transaction: {
    select: { id: true, status: true, amount: true, settledAt: true },
  },
} as const

async function findInvoiceForCaller(invoiceId: string, userId: string) {
  // Owned-by-caller path is the common case — try it first to avoid a
  // second round-trip when the caller isn't a collaborator.
  const owned = await prisma.invoice.findFirst({
    where: { id: invoiceId, userId },
    select: invoiceSelection,
  })
  if (owned) return owned
  // Fall back to the collaborator path. The `where` filter does the
  // ownership check in a single query so an invoice the caller has no
  // relationship with returns null.
  return prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      collaborators: { some: { userId } },
    },
    select: invoiceSelection,
  })
}

async function GETHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  if (!id || typeof id !== 'string') {
    return NextResponse.json({ error: 'INVALID_INPUT', message: 'invoice id required' }, { status: 400 })
  }

  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'UNAUTHORIZED', message: 'invalid or missing token' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
  if (!user) {
    return NextResponse.json({ error: 'UNAUTHORIZED', message: 'user not found' }, { status: 401 })
  }

  const invoice = await findInvoiceForCaller(id, user.id)
  if (!invoice) {
    return NextResponse.json({ error: 'NOT_FOUND', message: 'invoice not found' }, { status: 404 })
  }

  const { status, isTerminal } = classify(invoice.status)
  const body: PaymentStatusResponse = {
    invoiceId: invoice.id,
    status,
    isTerminal,
    paymentLink: invoice.paymentLink,
    amountDue: Number(invoice.amount),
    currency: invoice.currency,
    dueDate: invoice.dueDate ? invoice.dueDate.toISOString() : null,
    paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
    transaction: invoice.transaction
      ? {
          id: invoice.transaction.id,
          status: invoice.transaction.status,
          amount: Number(invoice.transaction.amount),
          settledAt: invoice.transaction.settledAt ? invoice.transaction.settledAt.toISOString() : null,
        }
      : null,
  }
  return NextResponse.json(body)
}

export const GET = withRequestId(GETHandler)
