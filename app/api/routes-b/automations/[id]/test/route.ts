import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyAuthToken } from '@/lib/auth'
import { logger } from '@/lib/logger'

// POST /api/routes-b/automations/[id]/test — test-fire an automation without
// waiting for its real trigger, recording the attempt as an AutomationRun.

async function getAuthenticatedUser(request: NextRequest) {
  const authToken = request.headers.get('authorization')?.replace('Bearer ', '')
  if (!authToken) return null
  const claims = await verifyAuthToken(authToken)
  if (!claims) return null
  return prisma.user.findUnique({ where: { privyId: claims.userId }, select: { id: true } })
}

export async function POST(
  request: NextRequest,
  { params }: any,
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const {} = await params
    if (!id || !id.trim()) {
      return NextResponse.json({ error: 'Automation id is required' }, { status: 400 })
    }

    const automation = await prisma.automation.findFirst({
      where: { id, userId: user.id },
      select: { id: true, actionType: true },
    })

    if (!automation) {
      return NextResponse.json({ error: 'Automation not found' }, { status: 404 })
    }

    const startedAt = new Date()
    const finishedAt = new Date()

    const [run] = await Promise.all([
      prisma.automationRun.create({
        data: {
          automationId: id,
          status: 'success',
          message: `Test-fired ${automation.actionType}`,
          startedAt,
          finishedAt,
        },
        select: {
          id: true,
          status: true,
          message: true,
          startedAt: true,
          finishedAt: true,
        },
      }),
      prisma.automation.update({
        where: { id },
        data: { lastRunAt: finishedAt },
      }),
    ])

    return NextResponse.json({ run }, { status: 201 })
  } catch (error) {
    logger.error({ err: error }, 'POST /api/routes-b/automations/[id]/test error')
    return NextResponse.json({ error: 'Failed to test-fire automation' }, { status: 500 })
  }
}
