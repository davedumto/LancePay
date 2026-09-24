import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

const DEFAULT_HOLD_THRESHOLD = 80

type JsonObject = Record<string, unknown>

function objectSignals(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    const { id } = await params
    const { searchParams } = new URL(request.url)
    const thresholdParam = searchParams.get('threshold')
    const threshold = thresholdParam === null ? DEFAULT_HOLD_THRESHOLD : Number(thresholdParam)

    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
      return NextResponse.json({ error: 'threshold must be an integer between 0 and 100' }, { status: 400 })
    }

    const assessment = await prisma.riskAssessment.findUnique({ where: { id } })
    if (!assessment) {
      return NextResponse.json({ error: 'Risk assessment not found' }, { status: 404 })
    }

    if (assessment.riskScore < threshold) {
      return NextResponse.json(
        { error: 'Risk score is below the automatic hold threshold', riskScore: assessment.riskScore, threshold },
        { status: 409 }
      )
    }

    const signals = objectSignals(assessment.signals)
    if (signals.autoHold && typeof signals.autoHold === 'object') {
      return NextResponse.json({ assessment, autoHold: signals.autoHold, idempotent: true })
    }

    const autoHold = {
      appliedAt: new Date().toISOString(),
      appliedBy: auth.actor.id,
      assessmentId: assessment.id,
      entityType: assessment.entityType,
      entityId: assessment.entityId,
      threshold,
      riskScore: assessment.riskScore,
    }

    const updated = await prisma.riskAssessment.update({
      where: { id: assessment.id },
      data: {
        status: 'hold_applied',
        signals: { ...signals, autoHold },
      },
    })

    return NextResponse.json({ assessment: updated, autoHold, idempotent: false })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/risk-assessments/[id]/auto-hold error')
    return NextResponse.json({ error: 'Failed to apply automatic hold' }, { status: 500 })
  }
}