import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// GET /api/referral-earnings/tiers
// Derives the caller's commission tier from their historical referral volume.

// Tiers are ordered by ascending volume threshold. commissionRate is the rate
// earned on future referrals once the caller reaches that tier.
const TIERS = [
  { tier: 'bronze', minVolumeUsdc: 0, commissionRate: 0.05 },
  { tier: 'silver', minVolumeUsdc: 1000, commissionRate: 0.07 },
  { tier: 'gold', minVolumeUsdc: 5000, commissionRate: 0.1 },
  { tier: 'platinum', minVolumeUsdc: 25000, commissionRate: 0.15 },
] as const

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Clawed-back earnings never counted toward real volume, so exclude them.
    const aggregate = await prisma.referralEarning.aggregate({
      where: { referrerId: user.id, status: { not: 'clawed_back' } },
      _sum: { amountUsdc: true },
    })
    const volumeUsdc = Number(aggregate._sum.amountUsdc ?? 0)

    let currentIndex = 0
    for (let i = 0; i < TIERS.length; i++) {
      if (volumeUsdc >= TIERS[i].minVolumeUsdc) {
        currentIndex = i
      }
    }

    const current = TIERS[currentIndex]
    const next = TIERS[currentIndex + 1] ?? null
    const volumeToNextTier = next
      ? Number((next.minVolumeUsdc - volumeUsdc).toFixed(6))
      : null

    return NextResponse.json({
      volumeUsdc: volumeUsdc.toFixed(6),
      currentTier: {
        tier: current.tier,
        minVolumeUsdc: current.minVolumeUsdc,
        commissionRate: current.commissionRate,
      },
      nextTier: next
        ? {
            tier: next.tier,
            minVolumeUsdc: next.minVolumeUsdc,
            commissionRate: next.commissionRate,
            volumeToNextTier,
          }
        : null,
      tiers: TIERS.map((t) => ({
        tier: t.tier,
        minVolumeUsdc: t.minVolumeUsdc,
        commissionRate: t.commissionRate,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/referral-earnings/tiers error')
    return NextResponse.json({ error: 'Failed to compute referral tier' }, { status: 500 })
  }
}
