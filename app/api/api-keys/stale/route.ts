import { NextRequest, NextResponse } from 'next/server'
import { verifyAuthToken } from '@/lib/auth'
import { prisma } from '@/lib/db'

const DEFAULT_STALENESS_DAYS = 90

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const claims = await verifyAuthToken(authToken)
    if (!claims) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // 2. Get user by privy ID
    const user = await prisma.user.findUnique({
      where: { privyId: claims.userId },
      select: { id: true, role: true },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // 3. Parse and validate query parameters
    const { searchParams } = new URL(request.url)
    const daysParam = searchParams.get('days')

    let staleDays = DEFAULT_STALENESS_DAYS

    if (daysParam !== null) {
      const parsed = Number(daysParam)

      if (!Number.isInteger(parsed) || parsed <= 0) {
        return NextResponse.json(
          { error: 'days parameter must be a positive integer' },
          { status: 400 }
        )
      }

      staleDays = parsed
    }

    // 4. Calculate staleness threshold timestamp
    const now = new Date()
    const thresholdDate = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000)

    // 5. Build the stale keys query
    // A key is stale if:
    // - lastUsedAt IS NULL (never used), OR
    // - lastUsedAt is older than the threshold
    const where = user.role === 'admin'
      ? {
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: thresholdDate } }],
        }
      : {
          userId: user.id,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: thresholdDate } }],
        }

    const staleKeys = await prisma.apiKey.findMany({
      where,
      select: {
        id: true,
        userId: true,
        name: true,
        keyHint: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ apiKeys: staleKeys })
  } catch (error) {
    console.error('GET /api/api-keys/stale error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch stale API keys' },
      { status: 500 }
    )
  }
}
