import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const trustScore = await prisma.userTrustScore.findUnique({
      where: { userId: user.id },
    })

    if (!trustScore) {
      return NextResponse.json({
        trustScore: {
          score: 50,
          totalVolumeUsdc: 0,
          disputeCount: 0,
          tier: 'silver',
        },
      })
    }

    return NextResponse.json({
      trustScore: {
        score: trustScore.score,
        totalVolumeUsdc: Number(trustScore.totalVolumeUsdc),
        disputeCount: trustScore.disputeCount,
        tier: 'silver',
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/trust-score error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
