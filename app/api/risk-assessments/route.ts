import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

// POST /api/risk-assessments — score an entity by combining transaction
// velocity, sanctions status and account age into one bounded riskScore.
// GET  /api/risk-assessments — list assessments (optionally filtered), most
// recent first.
//
// Both are compliance-only: risk scoring surfaces sanctions/PEP signals that
// must not be readable by the entity being scored.

const ALLOWED_ENTITY_TYPES = ['user', 'invoice'] as const
type EntityType = (typeof ALLOWED_ENTITY_TYPES)[number]

// riskScore is bounded to [0, 100]. Status is derived from the score:
//   >= FLAG_THRESHOLD -> "flagged"
//   >= LOG_THRESHOLD  -> "logged"
//   otherwise         -> "cleared"
const MIN_SCORE = 0
const MAX_SCORE = 100
const FLAG_THRESHOLD = 70
const LOG_THRESHOLD = 30

// Signal weights, documented here since they drive the final score and are
// the first thing a reviewer will want to tune.
const WEIGHTS = {
  sanctions: 0.5,
  velocity: 0.3,
  accountAge: 0.2,
}

const VELOCITY_WINDOW_HOURS = 24

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

class RiskAssessmentError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function isEntityType(value: unknown): value is EntityType {
  return typeof value === 'string' && (ALLOWED_ENTITY_TYPES as readonly string[]).includes(value)
}

function clampScore(score: number): number {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, Math.round(score)))
}

function statusForScore(score: number): 'flagged' | 'logged' | 'cleared' {
  if (score >= FLAG_THRESHOLD) return 'flagged'
  if (score >= LOG_THRESHOLD) return 'logged'
  return 'cleared'
}

function sanctionsScoreFor(status: string | null): number {
  switch (status) {
    case 'flagged':
      return 100
    case 'under_review':
      return 60
    case 'clear':
      return 0
    default:
      // No screening on file at all is treated as a mild, not severe, risk.
      return 30
  }
}

function velocityScoreFor(count: number): number {
  // 7+ transactions inside the window maxes out the signal.
  return Math.min(count * 15, 100)
}

function accountAgeScoreFor(ageDays: number): number {
  if (ageDays < 1) return 100
  if (ageDays < 7) return 70
  if (ageDays < 30) return 40
  if (ageDays < 90) return 15
  return 0
}

function parsePositiveInteger(value: string | null, fallback: number): number | null {
  if (value === null) return fallback
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

async function resolveTargetUserId(entityType: EntityType, entityId: string): Promise<string> {
  if (entityType === 'user') {
    const user = await prisma.user.findUnique({ where: { id: entityId }, select: { id: true } })
    if (!user) throw new RiskAssessmentError(404, 'User not found for entityId')
    return user.id
  }

  const invoice = await prisma.invoice.findUnique({ where: { id: entityId }, select: { id: true, userId: true } })
  if (!invoice) throw new RiskAssessmentError(404, 'Invoice not found for entityId')
  return invoice.userId
}

async function computeSignals(userId: string) {
  const windowStart = new Date(Date.now() - VELOCITY_WINDOW_HOURS * 60 * 60 * 1000)

  const [user, screening, recentTransactionCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { createdAt: true } }),
    prisma.sanctionsScreening.findUnique({ where: { userId }, select: { status: true } }),
    prisma.transaction.count({ where: { userId, createdAt: { gte: windowStart } } }),
  ])

  if (!user) throw new RiskAssessmentError(404, 'User not found')

  const accountAgeDays = Math.max(
    0,
    (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  )

  const sanctionsStatus = screening?.status ?? 'unscreened'
  const sanctionsScore = sanctionsScoreFor(screening?.status ?? null)
  const velocityScore = velocityScoreFor(recentTransactionCount)
  const accountAgeScore = accountAgeScoreFor(accountAgeDays)

  const weightedScore =
    sanctionsScore * WEIGHTS.sanctions +
    velocityScore * WEIGHTS.velocity +
    accountAgeScore * WEIGHTS.accountAge

  const riskScore = clampScore(weightedScore)

  const signals = {
    transactionVelocity: {
      count: recentTransactionCount,
      windowHours: VELOCITY_WINDOW_HOURS,
      score: velocityScore,
    },
    sanctionsStatus: {
      status: sanctionsStatus,
      score: sanctionsScore,
    },
    accountAge: {
      days: Math.round(accountAgeDays * 100) / 100,
      score: accountAgeScore,
    },
    weights: WEIGHTS,
    userId,
  }

  return { riskScore, signals }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const payload = (body ?? {}) as { entityType?: unknown; entityId?: unknown }

    if (!isEntityType(payload.entityType)) {
      return NextResponse.json(
        { error: `entityType must be one of: ${ALLOWED_ENTITY_TYPES.join(', ')}` },
        { status: 400 },
      )
    }

    if (typeof payload.entityId !== 'string' || !payload.entityId.trim()) {
      return NextResponse.json({ error: 'entityId is required' }, { status: 400 })
    }

    const entityType = payload.entityType
    const entityId = payload.entityId.trim()

    const userId = await resolveTargetUserId(entityType, entityId)
    const { riskScore, signals } = await computeSignals(userId)
    const status = statusForScore(riskScore)

    const assessment = await prisma.riskAssessment.create({
      data: {
        entityType,
        entityId,
        riskScore,
        signals,
        status,
      },
    })

    return NextResponse.json({ assessment }, { status: 201 })
  } catch (error) {
    if (error instanceof RiskAssessmentError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    logger.error({ err: error }, 'POST /api/risk-assessments error')
    return NextResponse.json({ error: 'Failed to create risk assessment' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    const { searchParams } = new URL(request.url)
    const entityTypeParam = searchParams.get('entityType')
    const entityId = searchParams.get('entityId') ?? undefined

    if (entityTypeParam !== null && !isEntityType(entityTypeParam)) {
      return NextResponse.json(
        { error: `entityType must be one of: ${ALLOWED_ENTITY_TYPES.join(', ')}` },
        { status: 400 },
      )
    }

    const page = parsePositiveInteger(searchParams.get('page'), 1)
    const requestedPageSize = parsePositiveInteger(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE)
    if (page === null || requestedPageSize === null) {
      return NextResponse.json({ error: 'page and pageSize must be positive integers' }, { status: 400 })
    }
    const pageSize = Math.min(requestedPageSize, MAX_PAGE_SIZE)

    const where = {
      ...(entityTypeParam ? { entityType: entityTypeParam } : {}),
      ...(entityId ? { entityId } : {}),
    }

    const [total, assessments] = await Promise.all([
      prisma.riskAssessment.count({ where }),
      prisma.riskAssessment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return NextResponse.json({
      assessments,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/risk-assessments error')
    return NextResponse.json({ error: 'Failed to fetch risk assessments' }, { status: 500 })
  }
}
