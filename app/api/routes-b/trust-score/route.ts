import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'

export async function GET(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const trustScore = await prisma.userTrustScore.findUnique({
    where: { userId: user.id },
    select: {
      score: true,
      totalVolumeUsdc: true,
      disputeCount: true,
      lastUpdatedAt: true,
    },
  })

  if (!trustScore) {
    return NextResponse.json({
      trustScore: {
        score: 50,
        totalVolumeUsdc: 0,
        disputeCount: 0,
        updatedAt: null,
      },
    })
  }

  return NextResponse.json({
    trustScore: {
      score: trustScore.score,
      totalVolumeUsdc: Number(trustScore.totalVolumeUsdc),
      disputeCount: trustScore.disputeCount,
      updatedAt: trustScore.lastUpdatedAt,
    },
  })
}
