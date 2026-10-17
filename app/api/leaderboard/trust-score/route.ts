import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100

function parsePositiveInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const requestedLimit = parsePositiveInteger(searchParams.get('limit'), DEFAULT_PAGE_SIZE)
    if (requestedLimit === null) {
      return NextResponse.json({ error: 'limit must be a positive integer' }, { status: 400 })
    }
    const limit = Math.min(requestedLimit, MAX_PAGE_SIZE)
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
