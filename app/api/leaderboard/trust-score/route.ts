import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const limitParam = searchParams.get('limit')
    const limit = limitParam ? parseInt(limitParam, 10) : 50
    const cursor = searchParams.get('cursor')

    const scores = await prisma.userTrustScore.findMany({
      where: {
        user: {
          publicVisibility: true,
        },
      },
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: [
        { score: 'desc' },
        { user: { createdAt: 'asc' } },
        { id: 'asc' },
      ],
      select: {
        id: true,
        score: true,
        totalVolumeUsdc: true,
        disputeCount: true,
        successfulInvoices: true,
        lastUpdatedAt: true,
        user: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
    })

    let nextCursor: string | undefined = undefined
    if (scores.length > limit) {
      const nextItem = scores.pop()
      nextCursor = nextItem?.id
    }

    return NextResponse.json({
      data: scores,
      nextCursor,
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/leaderboard/trust-score error')
    return NextResponse.json({ error: 'Failed to fetch leaderboard' }, { status: 500 })
  }
}
