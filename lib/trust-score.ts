import type { Prisma, PrismaClient, UserTrustScore } from '@prisma/client'
import { prisma } from '@/lib/db'

type Db = PrismaClient | Prisma.TransactionClient

// A cached UserTrustScore is reused for this long before GET recomputes it.
// Inputs only move when invoices settle or disputes open, so an hour keeps the
// signal current without re-aggregating on every page load.
export const TRUST_SCORE_TTL_MS = 60 * 60 * 1000

export interface InvoiceOutcomeCounts {
  paid: number
  decided: number
}

export interface TrustScoreSignals extends InvoiceOutcomeCounts {
  disputes: number
  accountAgeDays: number
}

/**
 * Trust score formula (0–100, integer):
 *
 *   score = round(completion + disputes + longevity), clamped to [0, 100]
 *
 * - completion (max 50): 50 × (paid + 1) / (decided + 2)
 *     "decided" invoices are those whose outcome is known: every invoice except
 *     ones still `pending` that are not yet past their due date (or have none).
 *     `paid` is the subset with status `paid`. The +1/+2 (Laplace smoothing)
 *     makes an account with no decided invoices score a neutral 25 and stops a
 *     single invoice from swinging the component to 0 or 50.
 * - disputes (max 30): max(0, 30 − 6 × disputes)
 *     every dispute ever raised against one of the user's invoices costs 6
 *     points; five or more disputes zero this component.
 * - longevity (max 20): 20 × min(1, accountAgeDays / 365)
 *     linear ramp from account creation, full credit after one year. A
 *     createdAt in the future is treated as age 0.
 *
 * A brand-new account with no history therefore scores 25 + 30 + 0 = 55.
 */
export function calculateUserTrustScore(signals: TrustScoreSignals): number {
  const paid = Math.max(0, signals.paid)
  const decided = Math.max(paid, signals.decided)
  const disputes = Math.max(0, signals.disputes)
  const ageDays = Math.max(0, signals.accountAgeDays)

  const completion = (50 * (paid + 1)) / (decided + 2)
  const disputeComponent = Math.max(0, 30 - 6 * disputes)
  const longevity = 20 * Math.min(1, ageDays / 365)

  const score = Math.round(completion + disputeComponent + longevity)
  return Math.min(100, Math.max(0, score))
}

export function isTrustScoreStale(lastUpdatedAt: Date, now: Date): boolean {
  return now.getTime() - lastUpdatedAt.getTime() >= TRUST_SCORE_TTL_MS
}

export async function countInvoiceOutcomes(
  userId: string,
  now: Date,
  db: Db = prisma
): Promise<InvoiceOutcomeCounts> {
  const [total, paid, openNotDue] = await Promise.all([
    db.invoice.count({ where: { userId } }),
    db.invoice.count({ where: { userId, status: 'paid' } }),
    db.invoice.count({
      where: { userId, status: 'pending', OR: [{ dueDate: null }, { dueDate: { gte: now } }] },
    }),
  ])
  return { paid, decided: total - openNotDue }
}

export async function loadTrustScoreSignals(
  user: { id: string; createdAt: Date },
  now: Date,
  db: Db = prisma
): Promise<TrustScoreSignals> {
  const [outcomes, disputes] = await Promise.all([
    countInvoiceOutcomes(user.id, now, db),
    db.dispute.count({ where: { invoice: { userId: user.id } } }),
  ])
  const accountAgeDays = (now.getTime() - user.createdAt.getTime()) / (24 * 60 * 60 * 1000)
  return { ...outcomes, disputes, accountAgeDays }
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

/**
 * Recomputes and persists the user's trust score.
 *
 * `lastUpdatedAt` is set to the moment the computation *started*, and an
 * existing row is only overwritten when its `lastUpdatedAt` is older. Two
 * concurrent recomputations therefore converge on the one that started last,
 * and a slow request can never replace a newer score with an older snapshot.
 */
export async function recomputeUserTrustScore(
  user: { id: string; createdAt: Date },
  now: Date = new Date(),
  db: Db = prisma
): Promise<UserTrustScore> {
  const signals = await loadTrustScoreSignals(user, now, db)
  const data = {
    score: calculateUserTrustScore(signals),
    disputeCount: signals.disputes,
    successfulInvoices: signals.paid,
    lastUpdatedAt: now,
  }

  const updated = await db.userTrustScore.updateMany({
    where: { userId: user.id, lastUpdatedAt: { lt: now } },
    data,
  })

  if (updated.count === 0) {
    try {
      await db.userTrustScore.create({ data: { userId: user.id, ...data } })
    } catch (error) {
      // A row already exists that is at least as fresh as this computation
      // (or was just created by a concurrent request) — keep it.
      if (!isUniqueViolation(error)) throw error
    }
  }

  return db.userTrustScore.findUniqueOrThrow({ where: { userId: user.id } })
}
