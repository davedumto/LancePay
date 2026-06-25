import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const VALID_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export async function POST(request: NextRequest) {
  try {
    const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
    if (!authToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const claims = await verifyAuthToken(authToken)
    if (!claims) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { privyId: claims.userId } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 401 })

    let body: { enabled?: unknown; startTime?: unknown; endTime?: unknown; days?: unknown; timezone?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { enabled = true, startTime, endTime, days, timezone = 'UTC' } = body

    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 422 })
    }
    if (enabled) {
      if (typeof startTime !== 'string' || !TIME_RE.test(startTime)) {
        return NextResponse.json({ error: 'startTime must be HH:MM' }, { status: 422 })
      }
      if (typeof endTime !== 'string' || !TIME_RE.test(endTime)) {
        return NextResponse.json({ error: 'endTime must be HH:MM' }, { status: 422 })
      }
      if (Array.isArray(days)) {
        const bad = (days as unknown[]).filter((d) => !VALID_DAYS.includes(d as string))
        if (bad.length > 0) {
          return NextResponse.json({ error: `Invalid days: ${bad.join(', ')}` }, { status: 422 })
        }
      }
    }

    const preference = await prisma.notificationPreference.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        quietHours: { enabled, startTime, endTime, days: days ?? VALID_DAYS, timezone },
      },
      update: {
        quietHours: { enabled, startTime, endTime, days: days ?? VALID_DAYS, timezone },
      },
      select: { id: true, quietHours: true, updatedAt: true },
    })

    logger.info({ userId: user.id, enabled }, 'Quiet hours configured')

    return NextResponse.json({ preference })
  } catch (error) {
    logger.error({ err: error }, 'POST /quiet-hours error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
