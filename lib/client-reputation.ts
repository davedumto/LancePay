import type { ClientReputation, Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'

type Db = PrismaClient | Prisma.TransactionClient

export const NEUTRAL_CLIENT_REPUTATION = 50

export interface ClientPaymentSignals {
  onTime: number
  late: number
  disputed: number
}

/**
 * Client reputation formula (0–100, integer; 50 = neutral):
 *
 *   score = round(100 × (onTime + 0.5 × late + 1) / (onTime + late + disputed + 2))
 *
 * Every invoice addressed to the client is classified at most once, disputes first:
 * - disputed: the invoice has a Dispute, whatever its status (weight 0)
 * - late:     paid after its due date, or still `pending` past its due date (weight 0.5)
 * - on-time:  `paid` with no due date or on/before it (weight 1)
 * Pending invoices not yet due and cancelled invoices carry no payment signal
 * and are ignored.
 *
 * The +1/+2 (Laplace smoothing) centres the score on 50 when there is no
 * history — no evidence is neutral, not perfect — and keeps a single invoice
 * from pinning the score to 0 or 100.
 */
export function calculateClientReputation(signals: ClientPaymentSignals): number {
  const onTime = Math.max(0, signals.onTime)
  const late = Math.max(0, signals.late)
  const disputed = Math.max(0, signals.disputed)

  const score = Math.round((100 * (onTime + 0.5 * late + 1)) / (onTime + late + disputed + 2))
  return Math.min(100, Math.max(0, score))
}

export async function loadClientPaymentSignals(
  clientEmail: string,
  now: Date,
  db: Db = prisma
): Promise<ClientPaymentSignals> {
  const base = { clientEmail, dispute: { is: null } } satisfies Prisma.InvoiceWhereInput
  const dueDate = db.invoice.fields.dueDate

  const [disputed, onTime, paidLate, overdue] = await Promise.all([
    db.invoice.count({ where: { clientEmail, dispute: { isNot: null } } }),
    db.invoice.count({
      where: {
        ...base,
        status: 'paid',
        OR: [{ dueDate: null }, { paidAt: null }, { paidAt: { lte: dueDate } }],
      },
    }),
    db.invoice.count({
      where: { ...base, status: 'paid', dueDate: { not: null }, paidAt: { gt: dueDate } },
    }),
    db.invoice.count({ where: { ...base, status: 'pending', dueDate: { lt: now } } }),
  ])

  return { onTime, late: paidLate + overdue, disputed }
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

/**
 * Persists the derived score on the email-keyed ClientReputation row.
 * Mirrors the trust-score write: a row is only replaced by a computation that
 * started after it was last checked, so concurrent requests cannot regress it.
 */
export async function saveClientReputation(
  clientEmail: string,
  paymentScore: number,
  checkedAt: Date,
  db: Db = prisma
): Promise<ClientReputation> {
  const updated = await db.clientReputation.updateMany({
    where: { clientEmail, lastCheckedAt: { lt: checkedAt } },
    data: { paymentScore, lastCheckedAt: checkedAt },
  })

  if (updated.count === 0) {
    try {
      await db.clientReputation.create({ data: { clientEmail, paymentScore, lastCheckedAt: checkedAt } })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
  }

  return db.clientReputation.findUniqueOrThrow({ where: { clientEmail } })
}
