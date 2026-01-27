import { NextRequest, NextResponse } from 'next/server'
import { getAuthContext } from '@/app/api/routes-d/disputes/_shared'
import { getUserTrustScoreData } from '@/lib/reputation'

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext(request)
    if ('error' in auth) {
      return NextResponse.json({ error: auth.error }, { status: 401 })
    }

    const scoreData = await getUserTrustScoreData(auth.user.id)

    if (!scoreData) {
      return NextResponse.json(
        { error: 'Failed to calculate trust score' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      score: scoreData.score,
      tier: scoreData.tier,
      breakdown: {
        baseScore: scoreData.breakdown.baseScore,
        volumeBonus: scoreData.breakdown.volumeBonus,
        historyBonus: scoreData.breakdown.historyBonus,
        disputePenalty: scoreData.breakdown.disputePenalty,
        verificationBonus: scoreData.breakdown.verificationBonus,
        totalVolumeUsdc: scoreData.breakdown.totalVolumeUsdc,
        successfulInvoices: scoreData.breakdown.successfulInvoices,
        lostDisputes: scoreData.breakdown.lostDisputes,
        isVerified: scoreData.breakdown.isVerified,
      },
      lastUpdatedAt: scoreData.lastUpdatedAt.toISOString(),
    })
  } catch (error) {
    console.error('Error fetching trust score:', error)
    return NextResponse.json(
      { 
        error: 'Failed to fetch trust score',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}
