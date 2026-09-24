import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

const DEFAULT_EXPIRY_DAYS = 180
const FLAGGED_THRESHOLD = 0.85
const UNDER_REVIEW_THRESHOLD = 0.65

function addDays(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

function statusFromScore(matchScore: number | null) {
  if (matchScore === null) return 'clear'
  if (matchScore >= FLAGGED_THRESHOLD) return 'flagged'
  if (matchScore >= UNDER_REVIEW_THRESHOLD) return 'under_review'
  return 'clear'
}

async function readBody(request: NextRequest) {
  const text = await request.text()
  return text.trim() ? JSON.parse(text) as Record<string, unknown> : {}
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('userId')
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })

    const screening = await prisma.sanctionsScreening.findUnique({ where: { userId } })
    if (!screening) return NextResponse.json({ error: 'Sanctions screening not found' }, { status: 404 })

    return NextResponse.json({ screening })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/sanctions-screenings error')
    return NextResponse.json({ error: 'Failed to fetch sanctions screening' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    let body: Record<string, unknown>
    try {
      body = await readBody(request)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })

    const matchScore = typeof body.matchScore === 'number' ? body.matchScore : null
    if (matchScore !== null && (matchScore < 0 || matchScore > 1)) {
      return NextResponse.json({ error: 'matchScore must be between 0 and 1' }, { status: 400 })
    }

    const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : 'manual'
    const expiresInDays = typeof body.expiresInDays === 'number' ? body.expiresInDays : DEFAULT_EXPIRY_DAYS
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 730) {
      return NextResponse.json({ error: 'expiresInDays must be an integer between 1 and 730' }, { status: 400 })
    }

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const screening = await prisma.sanctionsScreening.upsert({
      where: { userId },
      create: {
        userId,
        provider,
        matchScore,
        status: statusFromScore(matchScore),
        screenedAt: new Date(),
        expiresAt: addDays(expiresInDays),
      },
      update: {
        provider,
        matchScore,
        status: statusFromScore(matchScore),
        screenedAt: new Date(),
        expiresAt: addDays(expiresInDays),
      },
    })

    return NextResponse.json({ screening, thresholds: { underReview: UNDER_REVIEW_THRESHOLD, flagged: FLAGGED_THRESHOLD } })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/sanctions-screenings error')
    return NextResponse.json({ error: 'Failed to save sanctions screening' }, { status: 500 })
  }
}