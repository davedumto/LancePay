import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

const DEFAULT_LOOKAHEAD_DAYS = 30
const MAX_LOOKAHEAD_DAYS = 365
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function parseInteger(value: string | null, fallback: number) {
  if (value === null) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : NaN
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    const { searchParams } = new URL(request.url)
    const days = parseInteger(searchParams.get('days'), DEFAULT_LOOKAHEAD_DAYS)
    if (!Number.isInteger(days) || days < 1 || days > MAX_LOOKAHEAD_DAYS) {
      return NextResponse.json({ error: `days must be an integer between 1 and ${MAX_LOOKAHEAD_DAYS}` }, { status: 400 })
    }

    const limit = parseInteger(searchParams.get('limit'), DEFAULT_LIMIT)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return NextResponse.json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` }, { status: 400 })
    }

    const now = new Date()
    const expiresBefore = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
    const screenings = await prisma.sanctionsScreening.findMany({
      where: { expiresAt: { gt: now, lte: expiresBefore } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      include: { user: { select: { id: true, email: true, role: true } } },
    })

    return NextResponse.json({ screenings, count: screenings.length, lookaheadDays: days })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/sanctions-screenings/expiring error')
    return NextResponse.json({ error: 'Failed to list expiring sanctions screenings' }, { status: 500 })
  }
}