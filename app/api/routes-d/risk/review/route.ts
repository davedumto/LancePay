import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const ENTITY_TYPES = ['user', 'invoice', 'transaction'] as const
type EntityType = typeof ENTITY_TYPES[number]

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({
    where: { privyId: claims.userId },
    select: { id: true },
  })
}

export async function POST(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const b = body as Record<string, unknown>

    const entityType = b?.entityType
    const entityId = b?.entityId
    const reason = b?.reason

    if (!entityType || !ENTITY_TYPES.includes(entityType as EntityType)) {
      return NextResponse.json(
        { error: `entityType must be one of: ${ENTITY_TYPES.join(', ')}` },
        { status: 400 },
      )
    }

    if (!entityId || typeof entityId !== 'string' || entityId.trim().length === 0) {
      return NextResponse.json({ error: 'entityId is required' }, { status: 400 })
    }

    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
      return NextResponse.json({ error: 'reason must be a string of at most 1000 characters' }, { status: 400 })
    }

    const assessment = await prisma.riskAssessment.create({
      data: {
        entityType: entityType as EntityType,
        entityId: entityId.trim(),
        riskScore: 0,
        signals: { requestedBy: user.id, reason: reason ?? null, manualReview: true },
        status: 'pending_review',
      },
      select: {
        id: true,
        entityType: true,
        entityId: true,
        status: true,
        createdAt: true,
      },
    })

    return NextResponse.json({ assessment }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-d/risk/review error')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
