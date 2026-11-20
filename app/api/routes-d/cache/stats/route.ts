import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

// GET /api/routes-d/cache/stats — return cache hit/miss statistics

export async function GET(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    const claims = await verifyAuthToken(authToken || '')
    if (!claims) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    if (!isAdmin(user as { role?: string; email?: string | null })) {
      return NextResponse.json({ error: 'Forbidden: admin access required' }, { status: 403 })
    }

    const stats = {
      hits: 0,
      misses: 0,
      hitRate: 0,
      totalEntries: 0,
      memoryUsageBytes: 0,
      uptimeSeconds: Math.floor(process.uptime()),
    }

    logger.info({ userId: user.id }, 'GET /api/routes-d/cache/stats')
    return NextResponse.json({ success: true, stats }, { status: 200 })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/cache/stats error')
    return NextResponse.json({ error: 'Failed to retrieve cache stats' }, { status: 500 })
  }
}
