import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { TRUST_SCORE_TTL_MS, recomputeUserTrustScore } from '@/lib/trust-score'
import { logger } from '@/lib/logger'

// Bounded per run so a large backlog can't exceed the serverless window.
const BATCH_SIZE = Number(process.env.TRUST_SCORE_CRON_BATCH_SIZE ?? 100)
const MAX_BATCHES = Number(process.env.TRUST_SCORE_CRON_MAX_BATCHES ?? 10)

/**
 * GET /api/cron/recompute-trust-scores
 *
 * Recomputes UserTrustScore rows older than TRUST_SCORE_TTL_MS so the
 * public leaderboard doesn't rank users on stale values. Selection is
 * bounded (BATCH_SIZE per query, MAX_BATCHES per run); users with no
 * invoice activity since their last computation are skipped because
 * their inputs cannot have changed.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const staleBefore = new Date(now.getTime() - TRUST_SCORE_TTL_MS)

  let recomputed = 0
  let skipped = 0
  let batches = 0

  try {
    while (batches < MAX_BATCHES) {
      const staleScores = await prisma.userTrustScore.findMany({
        where: { lastUpdatedAt: { lt: staleBefore } },
        include: { user: { select: { id: true, createdAt: true } } },
        orderBy: { lastUpdatedAt: 'asc' },
        take: BATCH_SIZE,
      })
      if (staleScores.length === 0) break
      batches++

      for (const score of staleScores) {
        try {
          // Inputs only move on invoice/dispute activity; skip users whose
          // invoices haven't changed since the score was last computed.
          const activity = await prisma.invoice.count({
            where: {
              userId: score.user.id,
              OR: [
                { createdAt: { gt: score.lastUpdatedAt } },
                { updatedAt: { gt: score.lastUpdatedAt } },
              ],
            },
          })
          if (activity === 0) {
            skipped++
            continue
          }

          await recomputeUserTrustScore(score.user, now)
          recomputed++
        } catch (error) {
          logger.error(
            { err: error, userId: score.user.id },
            'Failed to recompute trust score',
          )
        }
      }

      if (staleScores.length < BATCH_SIZE) break
    }

    return NextResponse.json({ recomputed, skipped, batches })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/cron/recompute-trust-scores error')
    return NextResponse.json({ error: 'Failed to recompute trust scores' }, { status: 500 })
  }
}
