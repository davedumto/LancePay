import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'
import { countInvoiceOutcomes } from '@/lib/trust-score'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * BadgeDefinition.criteriaJson shapes (see BADGE_SETUP.md):
 *   { type: "revenue",         minRevenue }                  completed payment volume
 *   { type: "invoices",        minInvoices }                 paid invoice count
 *   { type: "zero_disputes",   minInvoices, maxDisputes }    paid invoices with few disputes
 *   { type: "completion_rate", minInvoices, minCompletionRate (0–100) }
 * Anything else — including "custom" — is never auto-awarded.
 */
export type BadgeCriteria =
  | { type: 'revenue'; minRevenue: number }
  | { type: 'invoices'; minInvoices: number }
  | { type: 'zero_disputes'; minInvoices: number; maxDisputes: number }
  | { type: 'completion_rate'; minInvoices: number; minCompletionRate: number }

export interface BadgeSignals {
  totalRevenue: number
  paidInvoices: number
  decidedInvoices: number
  disputeCount: number
}

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function parseBadgeCriteria(json: unknown): BadgeCriteria | null {
  if (typeof json !== 'object' || json === null) return null
  const c = json as Record<string, unknown>
  switch (c.type) {
    case 'revenue':
      return nonNegative(c.minRevenue) ? { type: 'revenue', minRevenue: c.minRevenue } : null
    case 'invoices':
      return nonNegative(c.minInvoices) ? { type: 'invoices', minInvoices: c.minInvoices } : null
    case 'zero_disputes':
      return nonNegative(c.minInvoices) && nonNegative(c.maxDisputes)
        ? { type: 'zero_disputes', minInvoices: c.minInvoices, maxDisputes: c.maxDisputes }
        : null
    case 'completion_rate':
      return nonNegative(c.minInvoices) && nonNegative(c.minCompletionRate)
        ? { type: 'completion_rate', minInvoices: c.minInvoices, minCompletionRate: c.minCompletionRate }
        : null
    default:
      return null
  }
}

export function meetsBadgeCriteria(criteria: BadgeCriteria, signals: BadgeSignals): boolean {
  switch (criteria.type) {
    case 'revenue':
      return signals.totalRevenue >= criteria.minRevenue
    case 'invoices':
      return signals.paidInvoices >= criteria.minInvoices
    case 'zero_disputes':
      return signals.paidInvoices >= criteria.minInvoices && signals.disputeCount <= criteria.maxDisputes
    case 'completion_rate': {
      if (signals.decidedInvoices === 0 || signals.decidedInvoices < criteria.minInvoices) return false
      return (signals.paidInvoices / signals.decidedInvoices) * 100 >= criteria.minCompletionRate
    }
  }
}

export async function loadBadgeSignals(userId: string, now: Date, db: Db = prisma): Promise<BadgeSignals> {
  const [revenue, outcomes, disputeCount] = await Promise.all([
    db.transaction.aggregate({
      where: { userId, type: 'payment', status: 'completed' },
      _sum: { amount: true },
    }),
    countInvoiceOutcomes(userId, now, db),
    db.dispute.count({ where: { invoice: { userId } } }),
  ])

  return {
    totalRevenue: Number(revenue._sum.amount ?? 0),
    paidInvoices: outcomes.paid,
    decidedInvoices: outcomes.decided,
    disputeCount,
  }
}
