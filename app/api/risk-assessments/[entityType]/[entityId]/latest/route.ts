import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { requireComplianceActor } from '@/app/api/_lib/compliance-auth'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ entityType: string; entityId: string }> }
) {
  try {
    const auth = await requireComplianceActor(request)
    if ('response' in auth) return auth.response

    const { entityType, entityId } = await params
    const assessment = await prisma.riskAssessment.findFirst({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
    })

    if (!assessment) {
      return NextResponse.json({ error: 'Risk assessment not found' }, { status: 404 })
    }

    return NextResponse.json({ assessment })
  } catch (error) {
    logger.error({ err: error }, 'GET /api/risk-assessments/[entityType]/[entityId]/latest error')
    return NextResponse.json({ error: 'Failed to fetch latest risk assessment' }, { status: 500 })
  }
}