import type { Prisma } from '@prisma/client'

/**
 * Days between a deletion request and the moment it becomes eligible for
 * processing. The request can be cancelled at any point inside this window.
 */
export const ACCOUNT_DELETION_GRACE_DAYS = 30
export const ACCOUNT_DELETION_GRACE_MS = ACCOUNT_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000

/**
 * AccountDeletionRequest.status lifecycle: pending → cancelled | completed.
 * Only a pending request whose scheduledAt is still in the future can be
 * cancelled; anything else means processing may already have started.
 */
export const DELETION_STATUS = {
  PENDING: 'pending',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
} as const

export const DATA_EXPORT_NOTIFICATION_TYPE = 'account_deletion_data_export'

// Invoice statuses that still expect money to move.
const UNPAID_INVOICE_STATUSES = ['pending', 'overdue']
// Dispute statuses that end a dispute (see dispute resolution flow).
const CLOSED_DISPUTE_STATUSES = ['resolved', 'closed']
// PayoutBatch is created as "processing" and ends as "completed" | "partial_failure".
const PENDING_PAYOUT_BATCH_STATUSES = ['pending', 'processing']
// WithdrawalTransaction terminal states are "completed" | "failed" | "reversed".
const PENDING_WITHDRAWAL_STATUSES = ['pending', 'interactive', 'submitted']

export type DeletionBlocker = {
  type: 'unpaid_invoices' | 'active_disputes' | 'pending_payouts'
  count: number
}

type BlockerClient = Pick<
  Prisma.TransactionClient,
  'invoice' | 'dispute' | 'payoutBatch' | 'withdrawalTransaction'
>

export async function findDeletionBlockers(db: BlockerClient, userId: string): Promise<DeletionBlocker[]> {
  const partyToInvoice: Prisma.InvoiceWhereInput = { OR: [{ userId }, { clientId: userId }] }

  const [unpaidInvoices, activeDisputes, pendingBatches, pendingWithdrawals] = await Promise.all([
    db.invoice.count({
      where: { ...partyToInvoice, status: { in: UNPAID_INVOICE_STATUSES } },
    }),
    db.dispute.count({
      where: {
        invoice: partyToInvoice,
        status: { notIn: CLOSED_DISPUTE_STATUSES },
        resolvedAt: null,
      },
    }),
    db.payoutBatch.count({
      where: { userId, status: { in: PENDING_PAYOUT_BATCH_STATUSES } },
    }),
    db.withdrawalTransaction.count({
      where: { userId, status: { in: PENDING_WITHDRAWAL_STATUSES } },
    }),
  ])

  const blockers: DeletionBlocker[] = []
  if (unpaidInvoices > 0) blockers.push({ type: 'unpaid_invoices', count: unpaidInvoices })
  if (activeDisputes > 0) blockers.push({ type: 'active_disputes', count: activeDisputes })
  const pendingPayouts = pendingBatches + pendingWithdrawals
  if (pendingPayouts > 0) blockers.push({ type: 'pending_payouts', count: pendingPayouts })
  return blockers
}

export function remainingGraceSeconds(scheduledAt: Date, now: Date): number {
  return Math.max(0, Math.floor((scheduledAt.getTime() - now.getTime()) / 1000))
}

export function isCancellable(request: { status: string; scheduledAt: Date }, now: Date): boolean {
  return request.status === DELETION_STATUS.PENDING && request.scheduledAt.getTime() > now.getTime()
}

type DeletionRequestRow = {
  id: string
  status: string
  reason: string | null
  scheduledAt: Date
  cancelledAt: Date | null
  completedAt: Date | null
  createdAt: Date
}

export const deletionRequestSelect = {
  id: true,
  status: true,
  reason: true,
  scheduledAt: true,
  cancelledAt: true,
  completedAt: true,
  createdAt: true,
} satisfies Prisma.AccountDeletionRequestSelect

export function serializeDeletionRequest(request: DeletionRequestRow, now: Date) {
  const cancellable = isCancellable(request, now)
  return {
    ...request,
    cancellable,
    remainingGraceSeconds: request.status === DELETION_STATUS.PENDING
      ? remainingGraceSeconds(request.scheduledAt, now)
      : 0,
  }
}
