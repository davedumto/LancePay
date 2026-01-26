import { NextRequest, NextResponse } from 'next/server'
import type { AuthTokenClaims } from '@privy-io/server-auth'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { ensureReferralCode, getReferralStats, getRecentReferralHistory } from '@/lib/referral'

async function getOrCreateUser(claims: AuthTokenClaims) {
  let user = await prisma.user.findUnique({ where: { privyId: claims.userId } })

  if (!user) {
    const email = (claims as { email?: string }).email || `${claims.userId}@privy.local`
    user = await prisma.user.create({
      data: { privyId: claims.userId, email },
    })
  }

  return user
}

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const user = await getOrCreateUser(claims)

    const referralCode = await ensureReferralCode(user.id)
    const stats = await getReferralStats(user.id)
    const recentHistory = await getRecentReferralHistory(user.id, 10)

    return NextResponse.json({
      referralCode,
      stats: {
        totalReferred: stats.totalReferred,
        totalEarnedUSDC: stats.totalEarnedUsdc,
        pendingPayout: stats.pendingPayout
      },
      recentHistory
    })
  } catch (error) {
    console.error('Referral stats error:', error)
    return NextResponse.json({ error: 'Failed to fetch referral stats' }, { status: 500 })
  }
}
