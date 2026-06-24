import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

type RiskAssessmentRecord = {
  riskScore: number
  status: string
  signals: unknown
  createdAt: Date
}

type RiskAssessmentDelegate = {
  findFirst: (args: Record<string, unknown>) => Promise<RiskAssessmentRecord | null>
}

type SanctionsScreeningRecord = {
  status: string
  provider: string
  matchScore: number | null
  screenedAt: Date
}

type SanctionsScreeningDelegate = {
  findUnique: (args: Record<string, unknown>) => Promise<SanctionsScreeningRecord | null>
}

type RiskFlag = {
  code: string
  severity: 'low' | 'medium' | 'high'
  source: 'risk_assessment' | 'sanctions_screening'
  message: string
  createdAt: Date
  metadata: Record<string, unknown>
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

function severityFromRiskScore(riskScore: number): RiskFlag['severity'] {
  if (riskScore >= 80) return 'high'
  if (riskScore >= 40) return 'medium'
  return 'low'
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
          signals: true,
          createdAt: true,
        },
      }),
      getSanctionsDelegate().findUnique({
        where: { userId: user.id },
        select: {
          status: true,
          provider: true,
          matchScore: true,
          screenedAt: true,
        },
      }),
    ])

    const flags: RiskFlag[] = []

    if (assessment && (assessment.riskScore > 0 || assessment.status !== 'logged')) {
      flags.push({
        code: assessment.status === 'pending_review' ? 'manual_review' : 'risk_assessment',
        severity: severityFromRiskScore(assessment.riskScore),
        source: 'risk_assessment',
        message:
          assessment.status === 'pending_review'
            ? 'Account is pending manual risk review'
            : `Account risk assessment recorded a score of ${assessment.riskScore}`,
        createdAt: assessment.createdAt,
        metadata: {
          status: assessment.status,
          riskScore: assessment.riskScore,
          signals: assessment.signals ?? null,
        },
      })
    }

    if (sanctions && sanctions.status !== 'clear') {
      flags.push({
        code: 'sanctions_screening',
        severity: sanctions.status === 'flagged' ? 'high' : 'medium',
        source: 'sanctions_screening',
        message:
          sanctions.status === 'flagged'
            ? 'Sanctions screening flagged the account'
            : 'Sanctions screening requires manual review',
        createdAt: sanctions.screenedAt,
        metadata: {
          status: sanctions.status,
          provider: sanctions.provider,
          matchScore: sanctions.matchScore,
        },
      })
    }

    return NextResponse.json({ flags })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/routes-d/risk/flags error')
    return NextResponse.json({ error: 'Failed to fetch risk flags' }, { status: 500 })
  }
}
