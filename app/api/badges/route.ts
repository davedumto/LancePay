import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const unearnedOnly =
      searchParams.get('unearned') === 'true' ||
      searchParams.get('notHeld') === 'true' ||
      searchParams.get('available') === 'true'

    let userId: string | null = null
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (authToken) {
      const claims = await verifyAuthToken(authToken)
      if (claims) {
        const user = await prisma.user.findUnique({
          where: { privyId: claims.userId },
          select: { id: true },
        })
        if (user) userId = user.id
      }
    }

    const whereClause: {
      isActive: boolean
      id?: { notIn: string[] }
    } = { isActive: true }

    if (unearnedOnly && userId) {
      const heldBadges = await prisma.userBadge.findMany({
        where: { userId },
        select: { badgeId: true },
      })
      const heldBadgeIds = heldBadges.map((b) => b.badgeId)
      whereClause.id = { notIn: heldBadgeIds }
    }

    const badges = await prisma.badgeDefinition.findMany({
      where: whereClause,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        criteriaJson: true,
        imageUrl: true,
        stellarAssetCode: true,
        isActive: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ badges })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/badges error')
    return NextResponse.json({ error: 'Failed to fetch badges' }, { status: 500 })
  }
}
