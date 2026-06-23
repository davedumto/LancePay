import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/withdrawals/limits — fetch withdrawal limits for the authenticated user ──
//
// Limits are tiered by the user's KYC level. A user with no KYC application
// is on the "none" tier; "basic" and "enhanced" tiers open progressively
// higher per-transaction and monthly ceilings. All amounts are in USDC.

const LIMITS_BY_KYC_LEVEL: Record<string, {
  perTransaction: number
  dailyUsdc: number
  monthlyUsdc: number
  anchors: string[]
}> = {
  none: {
    perTransaction: 100,
    dailyUsdc: 100,
    monthlyUsdc: 500,
    anchors: [],
  },
  basic: {
    perTransaction: 1_000,
    dailyUsdc: 2_000,
    monthlyUsdc: 10_000,
    anchors: ['moneygram', 'yellowcard'],
  },
  enhanced: {
    perTransaction: 10_000,
    dailyUsdc: 20_000,
    monthlyUsdc: 100_000,
    anchors: ['moneygram', 'yellowcard'],
  },
}

type KycApplicationDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>
}

function getKycDelegate(): KycApplicationDelegate {
  return (prisma as unknown as { kycApplication: KycApplicationDelegate }).kycApplication
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const kyc = await getKycDelegate().findUnique({
      where: { userId: user.id },
      select: { level: true, status: true },
    })

    // Only treat an *approved* KYC application as unlocking a higher tier.
    const kycLevel =
      kyc && (kyc as { status: string }).status === 'approved'
        ? (kyc as { level: string }).level
        : 'none'

    const tier = LIMITS_BY_KYC_LEVEL[kycLevel] ?? LIMITS_BY_KYC_LEVEL.none

    return NextResponse.json({
      kycLevel,
      limits: {
        perTransaction: { amountUsdc: tier.perTransaction },
        daily: { amountUsdc: tier.dailyUsdc },
        monthly: { amountUsdc: tier.monthlyUsdc },
      },
      supportedAnchors: tier.anchors,
      currency: 'USDC',
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/withdrawals/limits error')
    return NextResponse.json({ error: 'Failed to fetch withdrawal limits' }, { status: 500 })
  }
}
