import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

const SANCTIONS_SCORE_BY_STATUS: Record<string, number> = {
  clear: 0,
  under_review: 60,
  flagged: 90,
}

type RiskAssessmentRecord = {
  riskScore: number
  status: string
  createdAt: Date
}

type RiskAssessmentDelegate = {
  findFirst: (args: Record<string, unknown>) => Promise<RiskAssessmentRecord | null>
}

type SanctionsScreeningRecord = {
  status: string
  screenedAt: Date
}

type SanctionsScreeningDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<SanctionsScreeningRecord | null>
}

function getRiskAssessmentDelegate(): RiskAssessmentDelegate {
  return (prisma as unknown as { riskAssessment: RiskAssessmentDelegate }).riskAssessment
}

function getSanctionsDelegate(): SanctionsScreeningDelegate {
  return (prisma as unknown as { sanctionsScreening: SanctionsScreeningDelegate }).sanctionsScreening
}

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

function resolveAccountStatus(
  assessmentStatus: string | null,
  sanctionsStatus: string | null,
): string {
  if (sanctionsStatus === 'flagged') return 'flagged'
  if (sanctionsStatus === 'under_review') return 'under_review'
  if (assessmentStatus) return assessmentStatus
  return 'clear'
}

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const [assessment, sanctions] = await Promise.all([
      getRiskAssessmentDelegate().findFirst({
        where: {
          entityType: 'user',
          entityId: user.id,
        },
        orderBy: { createdAt: 'desc' },
        select: {
          riskScore: true,
          status: true,
          createdAt: true,
        },
      }),
      getSanctionsDelegate().findUnique({
        where: { userId: user.id },
        select: {
          status: true,
          screenedAt: true,
        },
      }),
    ])

    const assessmentScore = assessment?.riskScore ?? 0
    const sanctionsStatus = sanctions?.status ?? 'unscreened'
    const sanctionsScore = SANCTIONS_SCORE_BY_STATUS[sanctionsStatus] ?? 0

    const updatedAtCandidates = [assessment?.createdAt, sanctions?.screenedAt].filter(
      (value): value is Date => value instanceof Date,
    )
    const updatedAt =
      updatedAtCandidates.length > 0
        ? updatedAtCandidates.sort((a, b) => b.getTime() - a.getTime())[0]
        : null

    return NextResponse.json({
      riskScore: Math.max(assessmentScore, sanctionsScore),
      status: resolveAccountStatus(assessment?.status ?? null, sanctions?.status ?? null),
      updatedAt,
      factors: {
        assessmentScore: assessment?.riskScore ?? null,
        assessmentStatus: assessment?.status ?? null,
        sanctionsStatus,
      },
    })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/risk/score error')
    return NextResponse.json({ error: 'Failed to fetch risk score' }, { status: 500 })
  }
}
