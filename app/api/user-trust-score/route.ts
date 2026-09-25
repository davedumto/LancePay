import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isTrustScoreStale, recomputeUserTrustScore, TRUST_SCORE_TTL_MS } from '@/lib/trust-score'

// GET /api/user-trust-score — the authenticated caller's own trust score.
// No user can be selected: the subject is always the token's user. The cached
// UserTrustScore row is returned while younger than TRUST_SCORE_TTL_MS and
// recomputed otherwise; the formula is documented in lib/trust-score.ts.

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, createdAt: true },
    })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const now = new Date()
    const cached = await prisma.userTrustScore.findUnique({ where: { userId: user.id } })
    const trustScore =
      cached && !isTrustScoreStale(cached.lastUpdatedAt, now)
        ? cached
        : await recomputeUserTrustScore(user, now)

    return NextResponse.json({
      score: trustScore.score,
      successfulInvoices: trustScore.successfulInvoices,
      disputeCount: trustScore.disputeCount,
      lastUpdatedAt: trustScore.lastUpdatedAt,
      nextRefreshAt: new Date(trustScore.lastUpdatedAt.getTime() + TRUST_SCORE_TTL_MS),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/user-trust-score error')
    return NextResponse.json({ error: 'Failed to fetch trust score' }, { status: 500 })
  }
}
