import { withRequestId } from '../_lib/with-request-id'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireScope, RoutesBForbiddenError } from '../_lib/authz'
import { getCacheValue, setCacheValue } from '../_lib/cache'
import { recordTrustScoreSnapshot } from '../_lib/trust-score-history'

const TRUST_SCORE_COOLDOWN_MS = 30_000

type TrustScorePayload = {
  trustScore: {
    score: number
    totalVolumeUsdc: number
    disputeCount: number
    updatedAt: Date | null
  }
}

function computeTrustScore(volume: number, successfulInvoices: number, disputeCount: number): number {
  const volumePoints = Math.min(30, Math.floor(volume / 1000))
  const invoicePoints = Math.min(25, successfulInvoices)
  const disputePenalty = Math.min(40, disputeCount * 10)
  return Math.max(0, Math.min(100, 45 + volumePoints + invoicePoints - disputePenalty))
}

async function recomputeTrustScore(userId: string): Promise<TrustScorePayload> {
  const [paidAgg, successfulInvoices, disputes] = await Promise.all([
    prisma.invoice.aggregate({
      where: { userId, status: 'paid' },
      _sum: { amount: true },
    }),
    prisma.invoice.count({ where: { userId, status: 'paid' } }),
    prisma.dispute.count({
      where: { invoice: { userId } },
    }),
  ])

  const totalVolumeUsdc = Number(paidAgg._sum.amount ?? 0)
  const score = computeTrustScore(totalVolumeUsdc, successfulInvoices, disputes)

  const trustScore = await prisma.userTrustScore.upsert({
    where: { userId },
    create: {
      userId,
      score,
      totalVolumeUsdc,
      disputeCount: disputes,
      successfulInvoices,
    },
    update: {
      score,
      totalVolumeUsdc,
      disputeCount: disputes,
      successfulInvoices,
      lastUpdatedAt: new Date(),
    },
    select: {
      score: true,
      totalVolumeUsdc: true,
      disputeCount: true,
      lastUpdatedAt: true,
    },
  })

  recordTrustScoreSnapshot(userId, trustScore.score)

  return {
    trustScore: {
      score: trustScore.score,
      totalVolumeUsdc: Number(trustScore.totalVolumeUsdc),
      disputeCount: trustScore.disputeCount,
      updatedAt: trustScore.lastUpdatedAt,
    },
  }
}

async function GETHandler(request: NextRequest) {
  try {
    const auth = await requireScope(request, 'routes-b:read')
    const force = request.nextUrl.searchParams.get('force') === 'true'

    if (force && auth.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden', code: 'FORBIDDEN' }, { status: 403 })
    }

    const cacheKey = `routes-b:trust-score:${auth.userId}`
    if (!force) {
      const cached = getCacheValue<TrustScorePayload>(cacheKey)
      if (cached) {
        return NextResponse.json(cached, { headers: { 'X-Cache': 'HIT' } })
      }
    }

    const payload = await recomputeTrustScore(auth.userId)
    setCacheValue(cacheKey, payload, TRUST_SCORE_COOLDOWN_MS)

    return NextResponse.json(payload, { headers: { 'X-Cache': 'MISS' } })
  } catch (error) {
    if (error instanceof RoutesBForbiddenError) {
      return NextResponse.json({ error: 'Forbidden', code: error.code }, { status: 403 })
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export const GET = withRequestId(GETHandler)
