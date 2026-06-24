import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { getClientIp, peekRateLimitStatus } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

// ── GET /api/routes-d/account/rate-limit — fetch current rate-limit status ──
//
// Returns the caller's current rate-limit state across all active middleware
// policies, identified by their IP address. The counters are read-only —
// this endpoint never consumes quota.

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  const claims = await verifyAuthToken(authToken || '')
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const ip = getClientIp(request)
    const policies = peekRateLimitStatus(ip)

    return NextResponse.json({
      ip,
      policies: policies.map((p) => ({
        policyId: p.policyId,
        limit: p.limit,
        remaining: p.remaining,
        resetAt: p.resetAt > 0 ? new Date(p.resetAt).toISOString() : null,
        allowed: p.allowed,
      })),
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/account/rate-limit error')
    return NextResponse.json({ error: 'Failed to fetch rate-limit status' }, { status: 500 })
  }
}
