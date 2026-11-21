import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/authorization'

const PURGE_TARGETS = ['sessions', 'notifications', 'all'] as const
type PurgeTarget = typeof PURGE_TARGETS[number]

const DEFAULT_OLDER_THAN_DAYS = 90
const MIN_OLDER_THAN_DAYS = 1

async function getAdminUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true, role: true },
  })
}

export async function POST(request: NextRequest) {
  try {
    const actor = await getAdminUser(request)
    if (!actor) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (!isAdmin(actor)) {
      return NextResponse.json({ error: 'Forbidden: admin role required' }, { status: 403 })
    }

    let body: unknown = {}
    try {
      const text = await request.text()
      body = text ? JSON.parse(text) : {}
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const b = body as Record<string, unknown>
    const target = (b?.target as PurgeTarget | undefined) ?? 'all'

    if (!PURGE_TARGETS.includes(target)) {
      return NextResponse.json(
        { error: `target must be one of: ${PURGE_TARGETS.join(', ')}` },
        { status: 400 },
      )
    }

    const olderThanDaysRaw = b?.olderThanDays
    let olderThanDays = DEFAULT_OLDER_THAN_DAYS
    if (olderThanDaysRaw !== undefined) {
      if (typeof olderThanDaysRaw !== 'number' || !Number.isInteger(olderThanDaysRaw) || olderThanDaysRaw < MIN_OLDER_THAN_DAYS) {
        return NextResponse.json({ error: 'olderThanDays must be a positive integer' }, { status: 400 })
      }
      olderThanDays = olderThanDaysRaw
    }

    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)

    let purgedSessions = 0
    let purgedNotifications = 0

    if (target === 'sessions' || target === 'all') {
      const result = await prisma.userSession.deleteMany({
        where: {
          revokedAt: { not: null },
          updatedAt: { lt: cutoff },
        },
      })
      purgedSessions = result.count
    }

    if (target === 'notifications' || target === 'all') {
      const result = await prisma.notification.deleteMany({
        where: {
          isRead: true,
          createdAt: { lt: cutoff },
        },
      })
      purgedNotifications = result.count
    }

    return NextResponse.json({
      purge: {
        target,
        olderThanDays,
        purgedSessions,
        purgedNotifications,
        purgedAt: new Date().toISOString(),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/admin/housekeeping/purge error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
